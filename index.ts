// TODO: use timestamps to avoid double-saves confusing the synchronization

import { FSWatcher, watch as fsWatch } from "fs";
import { join as pathJoin } from "path";
import {
  BuildConfig,
  BunFile,
  BunPlugin,
  OnLoadResult,
  PluginBuilder,
  PluginConstraints,
  Server,
  ServerWebSocket,
} from "bun";
import { stat } from "fs/promises";
import z from "zod";
import { buildHmr } from "./build-hmr" assert { type: "macro" };

const hmr = buildHmr();

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

class HtmlHmrInjector implements HTMLRewriterTypes.HTMLRewriterElementContentHandlers {
  done = false;

  element(element: HTMLRewriterTypes.Element): void {
    if (this.done) return;
    this.done = true;
    element.before(`<script>${hmr}</script>`, { html: true });
  }
}

class HtmlDepTracker implements HTMLRewriterTypes.HTMLRewriterElementContentHandlers {
  readonly deps = new Set<string>();

  element(element: HTMLRewriterTypes.Element): void {
    try {
      for (const [k, v] of element.attributes) {
        if (k === "src" || k === "srcset") {
          // TODO: match fully qualified URLs to the local server too
          if (v.match(/^\/\/|https?:\/\//) === null) {
            this.deps.add(pathJoin(".", v));
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

    const depTracker = new HtmlDepTracker();
    const injector = new HtmlHmrInjector();
    const rewriter = new HTMLRewriter()
      .on(
        // Don't need to handle scripts here; they'll add hmr subscriptions for themselves
        // TODO: match host in selector rather than parsing in handler
        "img[src], source[src], source[srcset]",
        depTracker,
      )
      .on("script", injector);
    const res = await rewriter.transform(new Response(file)).text();

    let endScript = "";
    if (!injector.done) {
      endScript += hmr;
    }
    if (depTracker.deps.size > 0) {
      // TODO: inject deps earlier so we don't wait for the full page load
      endScript += `__hmr(${setToJson(depTracker.deps)});`;
    }

    return new Response(endScript === "" ? res : [res, `<script>${endScript}</script>`], {
      headers: {
        "Content-Type": file.type,
      },
    });
  },

  async bundle(req: Request, file: BunFile, server: Server, opts: ServeOptions): Promise<Response> {
    if (file.name === undefined) {
      throw new Error("empty file name");
    }

    const deps = new Set<string>();
    const plugin: BunPlugin = {
      name: "nova dependency tracker",
      setup(build: PluginBuilder) {
        build.onLoad({ filter: /^/ }, ({ namespace, path }) => {
          if (namespace === "file") {
            deps.add(path);
          }
          // FIXME: https://github.com/oven-sh/bun/pull/6346
          return undefined as unknown as OnLoadResult;
        });
      },
    };

    const result = await Bun.build({
      ...opts,
      plugins: [plugin, ...(opts.plugins ?? [])],
      entrypoints: [file.name],
      outdir: undefined,
      target: "browser",
    });

    for (const dep of deps) {
      watch(server, dep, dep);
    }

    const hmrCall = `__hmr(${setToJson(deps)});\n`;

    if (result.success) {
      return new Response([hmrCall, result.outputs[0]], {
        headers: {
          "Content-Type": file.type,
        },
      });
    } else {
      console.error(`[${file.name}] build failed:`);
      const errors = [];
      for (const log of result.logs) {
        let msg = `${log.message}`;
        if (log.position !== null) {
          msg += `\n    at ${log.position.file}:${log.position.line}:${log.position.column}`;
        }
        console.error(" ", msg);
        errors.push(msg);
      }
      const printErrors = `for(let e of${JSON.stringify(errors)}){console.error(e)}`;

      return new Response([hmrCall, printErrors], {
        headers: {
          "Content-Type": "application/javascript;charset=utf-8",
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

function setToJson(set: Set<string>): string {
  return JSON.stringify([...set.values()]);
}

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
