import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// scripts/update-manifests.mjs writes package.json's description (and the
// homepage, version, license, URLs and hashes) into Ruby double-quoted strings
// in the Homebrew formula. These tests pin the escaping that keeps each value a
// plain string (CodeQL js/incomplete-sanitization). The file sits one level
// below the repo root in both layouts -- src/ and the compiled dist/ -- so the
// same hop reaches scripts/.
const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "update-manifests.mjs");

interface FormulaAsset {
  url: string;
  sha256: string;
}
interface FormulaInput {
  className: string;
  cmd: string;
  description: unknown;
  homepage: string;
  version: string;
  license?: string;
  proprietary: boolean;
  assets: { macArm64: FormulaAsset; macX64: FormulaAsset; linuxX64: FormulaAsset };
}

let rubyString: (value: unknown) => string;
let renderFormula: (input: FormulaInput) => string;

before(async () => {
  // A computed specifier keeps tsc from resolving the untyped .mjs. Importing
  // it must not run main() (which would call `gh release download`).
  const mod = (await import(pathToFileURL(scriptPath).href)) as {
    rubyString: typeof rubyString;
    renderFormula: typeof renderFormula;
  };
  rubyString = mod.rubyString;
  renderFormula = mod.renderFormula;
});

// Read the body of a Ruby double-quoted literal the way Ruby does, failing on
// anything that would end the string early or interpolate code.
function parseRubyDq(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") {
      const next = body[++i];
      if (next === undefined) throw new Error("dangling backslash escapes the closing quote");
      out += next === "n" ? "\n" : next === "r" ? "\r" : next;
    } else if (c === '"') {
      throw new Error(`unescaped quote at ${i} ends the string early`);
    } else if (c === "#" && /[{@$]/.test(body[i + 1] ?? "")) {
      throw new Error(`unescaped interpolation at ${i}`);
    } else if (c === "\n" || c === "\r") {
      throw new Error(`raw line break at ${i}`);
    } else {
      out += c;
    }
  }
  return out;
}

// Pull the body of `  <stanza> "..."` out of a rendered formula, honouring
// backslash escapes so an escaped quote does not end it.
function stanzaBody(formula: string, stanza: string): string {
  const m = formula.match(new RegExp(`^  ${stanza} "((?:[^"\\\\]|\\\\.)*)"$`, "m"));
  assert.ok(m, `no single-line ${stanza} stanza in:\n${formula}`);
  return m[1];
}

const asset = (name: string): FormulaAsset => ({
  url: `https://github.com/YawLabs/npmjs-mcp/releases/download/v1.2.3/${name}`,
  sha256: "a".repeat(64),
});

function formulaInput(overrides: Partial<FormulaInput> = {}): FormulaInput {
  return {
    className: "NpmjsMcp",
    cmd: "npmjs-mcp",
    description: "npm MCP server",
    homepage: "https://yaw.sh/mcp-servers/npmjs-mcp/",
    version: "1.2.3",
    license: "MIT",
    proprietary: false,
    assets: {
      macArm64: asset("npmjs-mcp-darwin-arm64"),
      macX64: asset("npmjs-mcp-darwin-x64"),
      linuxX64: asset("npmjs-mcp-linux-x64"),
    },
    ...overrides,
  };
}

const hostile = [
  "npm MCP server: registry tools for package metadata, security audits, dependency trees, and write ops (deprecate, dist-tag, owner).",
  'He said "hi"',
  "trailing backslash \\",
  'backslash then quote \\"',
  "C:\\path\\to\\thing",
  '#{system("rm -rf ~")}',
  "#@ivar and #$global",
  "line one\nline two\r\n",
  "",
];

describe("update-manifests rubyString", () => {
  for (const input of hostile) {
    it(`round-trips ${JSON.stringify(input)}`, () => {
      assert.equal(parseRubyDq(rubyString(input)), input);
    });
  }

  it("escapes the backslash before the quote", () => {
    // The old `.replace(/"/g, '\\"')` turned `\"` into `\\"`, which Ruby reads
    // as an escaped backslash followed by a closing quote.
    assert.equal(rubyString('a\\"b'), 'a\\\\\\"b');
  });

  it("escapes # only where it starts interpolation", () => {
    // brew style flags `\#` that is not followed by {, @ or $ as redundant.
    assert.equal(rubyString("C# support, issue #12"), "C# support, issue #12");
    assert.equal(rubyString("#{x} #@y #$z"), "\\#{x} \\#@y \\#$z");
  });

  it("treats null and undefined as empty", () => {
    assert.equal(rubyString(undefined), "");
    assert.equal(rubyString(null), "");
  });
});

describe("update-manifests renderFormula", () => {
  for (const description of hostile) {
    it(`keeps desc ${JSON.stringify(description)} a plain string`, () => {
      const formula = renderFormula(formulaInput({ description }));
      assert.equal(parseRubyDq(stanzaBody(formula, "desc")), description);
    });
  }

  it("escapes homepage, version and license too", () => {
    const formula = renderFormula(formulaInput({ homepage: 'https://x/"#{1}', version: '1.0"', license: 'MIT"\\' }));
    assert.equal(parseRubyDq(stanzaBody(formula, "homepage")), 'https://x/"#{1}');
    assert.equal(parseRubyDq(stanzaBody(formula, "version")), '1.0"');
    assert.equal(parseRubyDq(stanzaBody(formula, "license")), 'MIT"\\');
  });

  it("renders a proprietary license as :cannot_represent", () => {
    const formula = renderFormula(formulaInput({ proprietary: true, license: "UNLICENSED" }));
    assert.match(formula, /^ {2}license :cannot_represent$/m);
  });

  it("renders the real package's values unchanged", () => {
    const formula = renderFormula(formulaInput());
    assert.match(formula, /^class NpmjsMcp < Formula$/m);
    assert.match(formula, /^ {2}desc "npm MCP server"$/m);
    assert.match(formula, /^ {2}license "MIT"$/m);
    assert.match(formula, /bin\.install Dir\["\*"\]\.first => "npmjs-mcp"$/m);
    assert.match(formula, /shell_output\("#\{bin\}\/npmjs-mcp --version"\)$/m);
  });

  it("rejects a class name that is not a Ruby constant", () => {
    assert.throws(() => renderFormula(formulaInput({ className: "Npm; system('x')" })), /Homebrew class name/);
  });
});
