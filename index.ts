#!/usr/bin/env bun
// TODO: use timestamps to avoid double-saves confusing the synchronization

import { hmr } from "./build-hmr" assert { type: "macro" };
import { FSWatcher, watch as fsWatch } from "fs";
import { stat } from "fs/promises";
import { Server, BunFile, ServerWebSocket, file, BuildConfig } from "bun";
import { extname, join as pathJoin } from "path";
import z from "zod";

type HandlerFn = (
  req: Request,
  file: BunFile,
  server: Server,
  opts: ServeOptions,
) => Response | Promise<Response>;

function watch(server: Server, topic: string, path: string) {
  if (!watchers.has(path)) {
    const w = fsWatch(path, { persistent: false }, (event, filename) => {
      server.publish(topic, JSON.stringify({ event, filename }));
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

const handlers = {
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

  async bundle(req: Request, file: BunFile, server: Server, opts: ServeOptions): Promise<Response> {
    if (file.name === undefined) {
      throw new Error("empty file name");
    }
    watch(server, file.name, file.name);

    // TODO: dependency tracking
    const result = await Bun.build({
      ...opts,
      entrypoints: [file.name],
      outdir: undefined,
      target: "browser",
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

const handlerMap: Map<string, HandlerFn> = new Map([
  ["text/html", handlers.html],
  ["text/javascript", handlers.bundle],
]);

type SocketData = { path: string };

export type ServeOptions = {
  port?: number;
} & Omit<BuildConfig, "entrypoints" | "outdir" | "target">;

export function serve(opts: ServeOptions = {}): void {
  if (opts.splitting) {
    throw new Error("TODO: support code splitting");
  }
  if (opts.sourcemap === "external") {
    throw new Error("TODO: support external sourcemaps");
  }
  if (opts.naming !== undefined) {
    throw new Error("TODO: support custom naming");
  }

  Bun.serve({
    port: opts.port ?? 3000,

    async fetch(req: Request, server: Server): Promise<Response | undefined> {
      let path = pathJoin(".", new URL(req.url).pathname);
      if ((await stat(path)).isDirectory()) {
        path = pathJoin(path, "index.html");
      }

      if (server.upgrade(req, { data: { path } })) {
        return;
      }

      const file = Bun.file(path);
      const handler = handlerMap.get(file.type.split(";", 1)[0]) ?? handlers.file;
      const res = handler(req, file, server, opts);
      return res;
    },

    error(err: Error): Response {
      if ("code" in err) {
        switch (err.code) {
          case "ENOENT":
            return new Response("404 Not Found", {
              status: 404,
              statusText: "Not Found",
            });
        }
      }
      throw err;
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
        const msgJson = JSON.parse(msg);
        const channels = z.string().array().parse(msgJson);
        for (const channel of channels) {
          if (typeof channel !== "string") {
            throw new Error("Invalid message");
          }
          ws.subscribe(channel);
        }
      },
    },
  });
}
