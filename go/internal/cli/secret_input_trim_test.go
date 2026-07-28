package cli

import (
	"strings"
	"testing"
)

// A submitted authorization code must survive trimming byte for byte, so this
// pins readSecretLine to JavaScript's String.prototype.trim rather than Go's
// strings.TrimSpace.
//
// The wanted values were captured by RUNNING the oracle
// (src/cli/runtime-api.ts readSecretLine) on the same input, not by reading the
// ECMAScript spec:
//
//	bun -e 'const {Readable}=await import("node:stream");
//	        const m=await import("./src/cli/runtime-api.ts");
//	        const s=Readable.from([Buffer.from("\u0085code\u0085\n","utf8")]);
//	        console.log(JSON.stringify(await m.readSecretLine({stdinImpl:s},"x")))'
//
// The two disagreements are the whole point. Go's TrimSpace ate U+0085, and it
// left U+FEFF in place; the oracle does the opposite in both cases.
func TestReadSecretLineTrimsLikeJavaScript(t *testing.T) {
	for _, testCase := range []struct {
		name  string
		input string
		want  string
	}{
		// U+0085 NEL is whitespace to Go and an ordinary character to
		// JavaScript, so the oracle keeps it and the code stays intact.
		{"NEL is preserved", "\u0085code\u0085\n", "\u0085code\u0085"},
		// U+FEFF is the realistic failure: a BOM-prefixed paste must be
		// stripped, or the upstream rejects a login the oracle completes.
		{"BOM is stripped", "\ufeffcode\ufeff\n", "code"},
		{"plain spaces", "  code  \n", "code"},
		{"tab", "\tcode\t\n", "code"},
		{"CRLF", "code\r\n", "code"},
		{"NBSP", "\u00a0code\u00a0\n", "code"},
		{"ideographic space", "\u3000code\u3000\n", "code"},
		{"no trailing newline", "code", "code"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			got, err := readSecretLine(strings.NewReader(testCase.input), "authorization code")
			if err != nil {
				t.Fatalf("readSecretLine(%q) error = %v", testCase.input, err)
			}
			if got != testCase.want {
				t.Fatalf("readSecretLine(%q) = %q (len %d), oracle returns %q (len %d)",
					testCase.input, got, len(got), testCase.want, len(testCase.want))
			}
		})
	}
}

// A line that is only whitespace is still empty input, not a credential.
func TestReadSecretLineRejectsWhitespaceOnly(t *testing.T) {
	if _, err := readSecretLine(strings.NewReader("   \n"), "authorization code"); err == nil {
		t.Fatal("a whitespace-only line must be reported as empty")
	}
}
