type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;

function write(level: Level, msg: string, fields?: Fields) {
  if (process.env.NODE_ENV === "test" && level !== "error") return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** Structured JSON logs (one line per event) - readable in Vercel's log viewer and any drain. */
export const log = {
  debug: (msg: string, f?: Fields) => write("debug", msg, f),
  info: (msg: string, f?: Fields) => write("info", msg, f),
  warn: (msg: string, f?: Fields) => write("warn", msg, f),
  error: (msg: string, f?: Fields) => write("error", msg, f),
};
