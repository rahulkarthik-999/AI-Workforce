/**
 * A small arithmetic evaluator (recursive descent). No eval(), no identifiers
 * beyond a fixed function whitelist - safe to run on model-supplied input.
 */
const FUNCTIONS: Record<string, (...a: number[]) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  round: (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d,
  floor: Math.floor,
  ceil: Math.ceil,
  min: Math.min,
  max: Math.max,
  ln: Math.log,
  log10: Math.log10,
  exp: Math.exp,
  pow: Math.pow,
};

export function evaluate(expression: string): number {
  const src = expression.replace(/\s+/g, "");
  if (!src) throw new Error("Empty expression.");
  if (src.length > 500) throw new Error("Expression too long.");
  let pos = 0;

  const peek = () => src[pos];
  const eat = (ch: string) => {
    if (src[pos] !== ch) throw new Error(`Expected "${ch}" at position ${pos}.`);
    pos++;
  };

  function expr(): number {
    let v = term();
    while (peek() === "+" || peek() === "-") {
      const op = src[pos++];
      const r = term();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }

  function term(): number {
    let v = unary();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = src[pos++];
      const r = unary();
      if ((op === "/" || op === "%") && r === 0) throw new Error("Division by zero.");
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
    return v;
  }

  function unary(): number {
    if (peek() === "-") {
      pos++;
      return -unary();
    }
    if (peek() === "+") {
      pos++;
      return unary();
    }
    return power();
  }

  function power(): number {
    const base = atom();
    if (peek() === "^") {
      pos++;
      return Math.pow(base, unary());
    }
    return base;
  }

  function atom(): number {
    if (peek() === "(") {
      pos++;
      const v = expr();
      eat(")");
      return v;
    }
    const num = src.slice(pos).match(/^\d+(\.\d+)?(e[+-]?\d+)?/i);
    if (num) {
      pos += num[0].length;
      return Number(num[0]);
    }
    const ident = src.slice(pos).match(/^[a-z][a-z0-9]*/i);
    if (ident) {
      const name = ident[0].toLowerCase();
      pos += ident[0].length;
      // Own-property lookup only: "constructor", "toString" etc. must not resolve via the prototype.
      const fn = Object.hasOwn(FUNCTIONS, name) ? FUNCTIONS[name] : undefined;
      if (!fn) throw new Error(`Unknown function "${name}".`);
      eat("(");
      const args: number[] = [];
      if (peek() !== ")") {
        args.push(expr());
        while (peek() === ",") {
          pos++;
          args.push(expr());
        }
      }
      eat(")");
      return fn(...args);
    }
    throw new Error(`Unexpected character "${peek() ?? "end"}" at position ${pos}.`);
  }

  const result = expr();
  if (pos !== src.length) throw new Error(`Unexpected character "${src[pos]}" at position ${pos}.`);
  if (!Number.isFinite(result)) throw new Error("Result is not a finite number.");
  return result;
}
