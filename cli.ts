import { version } from "./package.json";
import { ServeOptions, serve } from ".";
import { cli } from "cleye";
import z from "zod";

const parsed = cli(
  {
    name: "nova",
    version,
    flags: {
      port: {
        type: Number,
        description: "Port number to listen on",
        alias: "p",
        default: 3000,
      },

      format: {
        type: String,
        description: "Specifies the module format to be used in generated bundles",
        default: "esm",
      },

      splitting: {
        type: Boolean,
        description: "Whether to enable code splitting",
        default: false,
      },

      sourcemap: {
        type: String,
        description: "Specifies the type of sourcemap to generate (external, inline, none)",
        default: "none",
      },

      // TODO: granular minification options
      minify: {
        type: Boolean,
        description: "Whether to enable minification",
        default: false,
      },

      external: {
        type: [String],
        description: "Specifies which import paths should be considered external",
        alias: "e",
      },

      publicPath: {
        type: String,
        description: "A prefix to be appended to any import paths in bundled code",
      },

      define: {
        type: [String],
        description: "Define a global identifier to be replaced at build time, name=value",
        alias: "d",
      },

      loader: {
        type: [String],
        description: "Declare the loader to use for a given file extension, .ext:loader",
        alias: "l",
      },
    },
  },
  (parsed) => {
    checkUnknown(parsed);

    // TODO: handle parse errors
    // TODO: a zod-based CLI parser would be able to provide much better help messages using this schema
    const opts: ServeOptions = z
      .object({
        help: z.undefined(),
        version: z.undefined(),

        port: z.number(),
        format: z.literal("esm"),
        splitting: z.boolean(),
        sourcemap: z.enum(["external", "inline", "none"]),
        minify: z.boolean(),
        external: z.string().array(),
        publicPath: z.string().optional(),
        define: z.string().transform(keyValue("=")).array().transform(kvsToObj),
        loader: z
          .string()
          .transform(keyValue(":"))
          .transform(([k, v]) => {
            const loader = z
              .enum(["js", "jsx", "ts", "tsx", "json", "toml", "file", "napi", "wasm", "text"])
              .parse(v);
            return [k, loader] as const;
          })
          .array()
          .transform(kvsToObj),
      })
      .strict()
      .parse(parsed.flags);

    console.log(`Starting dev server at http://localhost:${parsed.flags.port}/`);
    serve(opts);
  },
);

function checkUnknown(parsed: {
  unknownFlags: Record<string, unknown>;
  showHelp: () => void;
}): void {
  let ok = true;
  for (const flag of Object.keys(parsed.unknownFlags)) {
    ok = false;
    console.error(`Unknown flag '${flag}'`);
  }
  if (!ok) process.exit(1);
}

function keyValue(sep: string): (s: string, ctx: z.RefinementCtx) => [string, string] {
  return (s, ctx) => {
    const kv = s.split(sep, 1);
    if (kv.length !== 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Must follow format 'key=value'",
      });
      return z.NEVER;
    }
    const value = JSON.parse(kv[1]);
    return [kv[0], value];
  };
}

function kvsToObj<K extends PropertyKey, V>(kvs: readonly (readonly [K, V])[]): Record<K, V> {
  const obj: Record<PropertyKey, V> = {};
  for (const [k, v] of kvs) {
    obj[k] = v;
  }
  return obj;
}
