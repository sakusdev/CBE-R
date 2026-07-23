# CBE-R

CBE-R converts Minecraft Bedrock Edition block captures into Minecraft Java Edition Structure NBT files.

> Use it only on servers and builds you are authorized to copy. CBE-R does not bypass permissions, hidden chunks, or server-side access controls.

## Implemented

- Java Structure NBT palette, block, block-entity, and entity encoding
- gzip-compressed and uncompressed output
- normalized Bedrock capture JSON input
- rectangular range selection and coordinate rebasing
- initial Bedrock-to-Java conversion for common blocks
- logs, slabs, stairs, doors, trapdoors, fences, walls, panes, fluids, signs, containers, leaves, and snow
- neighbor pass for stairs and connectable blocks
- unsupported-block policies: barrier, air, or error
- command-line export
- authenticated/offline Bedrock packet recording to append-only NDJSON
- GitHub Actions typecheck, test, npm package build, standalone executable build, checksums, and artifact upload

## Standalone executables

GitHub Actions builds binaries that include their own runtime, so end users do not need Node.js or Bun installed:

- Windows x64: `cbe-r-windows-x64.exe`
- Linux x64: `cbe-r-linux-x64`
- Linux ARM64: `cbe-r-linux-arm64`
- macOS Intel: `cbe-r-macos-x64`
- macOS Apple Silicon: `cbe-r-macos-arm64`

Download the `cbe-r-standalone` artifact from a successful **Standalone binaries** workflow run. Verify it against `SHA256SUMS.txt`, extract it, and run the executable directly.

On Linux and macOS, make it executable if necessary:

```bash
chmod +x cbe-r-linux-x64
./cbe-r-linux-x64 --help
```

The binaries are built with Bun's standalone compiler. The Linux x64 build uses the baseline target for compatibility with older x86-64 processors.

## Development requirements

Node.js 20 or newer is only required when building from source.

```bash
npm install
npm run check
npm run build
```

## Capture format

CBE-R uses this normalized JSON format between packet decoding and structure conversion:

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
    },
    {
      "pos": [101, 64, 100],
      "block": { "name": "minecraft:chest", "states": { "direction": 2 } },
      "blockEntity": { "id": "minecraft:chest", "CustomName": "Storage" }
    }
  ],
  "entities": [
    {
      "pos": [100.5, 65, 100.5],
      "nbt": { "id": "minecraft:armor_stand", "Invisible": false }
    }
  ]
}
```

Only chunks delivered to the client can be represented. A capture adapter must not attempt to retrieve unloaded or unauthorized server data.

## CLI

Capture a reproducible packet journal from a server:

```bash
cbe-r capture \
  --host example.org \
  --port 19132 \
  --username ProfileName \
  --profiles-folder .auth \
  --output session.ndjson
```

Export a normalized capture to Java Structure NBT:

```bash
cbe-r export \
  --input capture.json \
  --output building.nbt \
  --from 100,64,100 \
  --to 140,100,140 \
  --include-entities
```

Export options:

- `--data-version 3955`
- `--uncompressed`
- `--include-air`
- `--include-entities`
- `--unsupported barrier|air|throw`

Place the resulting file under:

```text
saves/<world>/generated/minecraft/structures/building.nbt
```

Then load `minecraft:building` from a Java Edition structure block.

## Library API

```ts
import { encodeJavaStructureGzip, extractJavaStructure } from "cbe-r";

const structure = extractJavaStructure(capture, [100, 64, 100], [140, 100, 140], {
  includeEntities: true,
  unsupportedBlockPolicy: "barrier",
});

const nbt = encodeJavaStructureGzip(structure);
```

## Remaining protocol work

The live recorder preserves real server traffic, authentication events, disconnects, and packet payloads. Direct conversion of a packet journal to normalized blocks still requires version-aware decoding for `level_chunk`, `sub_chunk`, runtime palettes, and block-entity packet variants.

Conversion coverage is intentionally conservative. Unsupported stateful blocks are reported through barrier replacement or strict errors rather than silently producing an incorrect Java block.

## License

Mozilla Public License 2.0. See [LICENSE](LICENSE).
