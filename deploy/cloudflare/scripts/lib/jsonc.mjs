// A minimal JSONC reader for wrangler.jsonc: strips `//` and `/* */` comments outside strings and
// trailing commas, then JSON.parses. Enough for the reference wrapper's own config.

export const parseJsonc = (text) => {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (inString) {
      out += char;
      if (char === "\\") { out += next; i += 1; } else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
    } else if (char === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
    } else out += char;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/gu, "$1"));
};
