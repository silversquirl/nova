#!/usr/bin/env bun
// TODO: use timestamps to avoid double-saves confusing the synchronization

import { hmr } from "./build-hmr" with { type: "macro" };
import { FSWatcher, watch as fsWatch } from "fs";
import { Server, BunFile, ServerWebSocket, file } from "bun";
import { extname, join as pathJoin } from "path";

type HandlerFn = (req: Request, file: BunFile, server: Server) => Response | Promise<Response>;

function watch(server: Server, topic: string, path: string) {
  if (!watchers.has(path)) {
    const w = fsWatch(path, { persistent: false }, (event, filename) => {
      console.log(topic, event, filename);
    });
    watchers.set(path, w);
  }
}
const watchers: Map<string, FSWatcher> = new Map();

class HtmlProcessor implements HTMLRewriterTypes.HTMLRewriterElementContentHandlers {
  readonly deps: string[] = [];

  element(element: HTMLRewriterTypes.Element): void {
    try {
      for (const [k, v] of element.attributes) {
        if (k === "src" || k === "srcset") {
          // TODO: match fully qualified URLs to the local server too
          if (v.match(/^\/\/|https?:\/\//) === null) {
            this.deps.push(pathJoin(".", v));
          }
        }
      }
    } catch (e) {
      // (Partial) workaround for https://github.com/oven-sh/bun/issues/6124
      console.error(e);
    }
  }
}

const serve = {
  async html(req: Request, file: BunFile, server: Server): Promise<Response> {
    if (file.name === undefined) {
      throw new Error("empty file name");
    }
    watch(server, file.name, file.name);

    const handler = new HtmlProcessor();
    // TODO: match host in selector rather than parsing in handler
    const rewriter = new HTMLRewriter().on(
      "script[src], img[src], source[src], source[srcset]",
      handler,
    );
    const res = await rewriter.transform(new Response(file)).text();
    const deps = JSON.stringify(handler.deps);

    return new Response([res, `<script>${hmr()}__hmr(${deps});</script>`], {
      headers: {
        "Content-Type": file.type,
      },
    });
  },

  async bundle(req: Request, file: BunFile, server: Server): Promise<Response> {
    if (file.name === undefined) {
      throw new Error("empty file name");
    }
    watch(server, file.name, file.name);

    // TODO: dependency tracking
    const result = await Bun.build({
      entrypoints: [file.name],
    });
    if (result.success) {
      return new Response(result.outputs[0], {
        headers: {
          "Content-Type": file.type,
        },
      });
    } else {
      let response = "Bundling failed:\n";
      for (const log of result.logs) {
        response += ` - ${log}\n`;
      }
      return new Response(response, {
        status: 500,
        statusText: "Internal Server Error",
        headers: {
          "Content-Type": "text/plain;charset=utf-8",
        },
      });
    }
  },

  file(req: Request, file: BunFile, server: Server): Response {
    if (file.name === undefined) {
      throw new Error("empty file name");
    }
    watch(server, file.name, file.name);
    return new Response(file);
  },
};

const handlers: Map<string, HandlerFn> = new Map([
  ["text/html", serve.html],
  ["text/javascript", serve.bundle],
]);

console.log("Starting server...");
Bun.serve({
  fetch(req: Request, server: Server): Response | Promise<Response> | undefined {
    const path = pathJoin(".", new URL(req.url).pathname);

    if (server.upgrade(req, { data: { path } })) {
      return;
    }

    const file = Bun.file(path);
    const handler = handlers.get(file.type.split(";", 1)[0]) ?? serve.file;
    const res = handler(req, file, server);
    return res;
  },

  websocket: {
    open(ws: ServerWebSocket<SocketData>) {
      ws.subscribe(ws.data.path);
    },
    close(ws: ServerWebSocket<SocketData>) {
      ws.unsubscribe(ws.data.path);
    },

    message(ws, msg) {
      if (typeof msg !== "string") {
        throw new Error("Invalid message");
      }
      const channels = JSON.parse(msg);
      if (!(channels instanceof Array)) {
        throw new Error("Invalid message");
      }
      for (const channel of channels) {
        if (typeof channel !== "string") {
          throw new Error("Invalid message");
        }
        ws.subscribe(channel);
      }
    },
  },
});

type SocketData = { path: string };
