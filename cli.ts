import { version } from "./package.json";
import { serve } from ".";
import { cli } from "cleye";

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
    },
  },
  (parsed) => {
    checkUnknown(parsed);
    console.log(`Starting dev server at http://localhost:${parsed.flags.port}/`);
    serve(parsed.flags);
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
