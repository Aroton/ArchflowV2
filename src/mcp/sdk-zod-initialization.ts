import { z } from "zod";

// The MCP SDK publishes pre-bundled ESM that constructs a recursive Zod schema at module scope.
// This local, side-effectful dependency keeps Zod's classic constructors initialized first when
// esbuild flattens the SDK with ArchFlow's live handler graph. A bare `zod` import cannot provide
// the fence because the package correctly declares itself side-effect-free and esbuild removes it.
if (typeof z.lazy !== "function") {
  throw new TypeError("the MCP runtime requires Zod classic schema constructors");
}
