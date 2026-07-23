# CBE-R

CBE-R records Minecraft Bedrock Edition client traffic and converts authorized block captures into Minecraft Java Edition Structure NBT files.

> Use it only on servers and builds you are authorized to copy. CBE-R does not bypass permissions, hidden chunks, or server-side access controls.

## Implemented

- authenticated or offline Bedrock packet recording to append-only NDJSON
- packet journal validation, statistics, Buffer/BigInt restoration, and chunk-packet extraction
- pluggable protocol decoder registry
- normalized packet/fixture decoder and CaptureDocument generation
- direct journal-to-NBT pipeline command
- Java Structure NBT palette, block, block-entity, and entity encoding
- rectangular range selection and coordinate rebasing
- common Bedrock-to-Java block-state conversion and neighbor resolution
- unsupported-block policies: barrier, air, or error
- Node.js package and standalone Windows/Linux/macOS binaries
- GitHub Actions typecheck, tests, package creation, binary validation, checksums, and artifact upload

## Standalone executables

GitHub Actions builds binaries containing their own runtime. End users do not need Node.js or Bun:

- Windows x64: `cbe-r-windows-x64.exe`
- Linux x64: `cbe-r-linux-x64`
- Linux ARM64: `cbe-r-linux-arm64`
- macOS Intel: `cbe-r-macos-x64`
- macOS Apple Silicon: `cbe-r-macos-arm64`

Download the `cbe-r-standalone` artifact from a successful **Standalone binaries** workflow run and verify it using `SHA256SUMS.txt`.

```bash
chmod +x cbe-r-linux-x64
./cbe-r-linux-x64 --help
```

## CLI workflow

Record packets delivered to the authenticated client:

```bash
cbe-r capture \
  --host example.org \
  --port 19132 \
  --username ProfileName \
  --profiles-folder .auth \
  --output session.ndjson
```

Inspect the journal before decoding:

```bash
cbe-r analyze --input session.ndjson
cbe-r analyze --input session.ndjson --json
```

Convert supported chunk records into normalized capture JSON:

```bash
cbe-r decode \
  --input session.ndjson \
  --output capture.json \
  --strict
```

Export normalized capture JSON to Java Structure NBT:

```bash
cbe-r export \
  --input capture.json \
  --output building.nbt \
  --from 100,64,100 \
  --to 140,100,140 \
  --include-entities
```

Decode and export in one command:

```bash
cbe-r pipeline \
  --input session.ndjson \
  --output building.nbt \
  --from 100,64,100 \
  --to 140,100,140 \
  --include-entities \
  --strict
```

Export options:

- `--data-version 3955`
- `--uncompressed`
- `--include-air`
- `--include-entities`
- `--unsupported barrier|air|throw`

Place the result under:

```text
saves/<world>/generated/minecraft/structures/building.nbt
```

Then load `minecraft:building` from a Java Edition structure block.

## Capture format

The stable conversion boundary is:

```json
{
  "format": "cbe-r-capture",
  "version": 1,
  "dimension": "minecraft:overworld",
  "blocks": [
    {
      "pos": [100, 64, 100],
      "block": {
        "name": "minecraft:oak_stairs",
        "states": {
          "weirdo_direction": 3,
          "upside_down_bit": false
        }
      }
    }
  ],
  "entities": []
}
```

Packet adapters and version decoders may attach normalized `blocks` and `entities` arrays to `level_chunk` or `sub_chunk` records. The built-in normalized decoder merges those records, applies last-write-wins behavior by block coordinate, and emits this format.

## Decoder API

```ts
import {
  decodeJournalToCapture,
  type JournalDecoder,
} from "cbe-r";

const decoder: JournalDecoder = {
  id: "bedrock-example",
  versions: ["1.21.0"],
  decode(record, context) {
    // Decode record.params using context.protocolVersion.
    return undefined;
  },
};

const capture = decodeJournalToCapture(journalText, {
  protocolVersion: "1.21.0",
  decoders: [decoder],
  strict: true,
});
```

## Current protocol boundary

The recorder preserves real server traffic and restores binary packet fields from the journal. Complete decoding of raw `level_chunk` and `sub_chunk` payload bytes still requires version-specific palette and subchunk decoders validated against real packet fixtures. Unsupported raw formats fail safely in strict mode instead of silently generating incorrect blocks.

Only chunks delivered to the client can be represented.

## Development

Node.js 20 or newer is required only when building from source.

```bash
npm install
npm run check
npm run build
```

## License

Mozilla Public License 2.0. See [LICENSE](LICENSE).
