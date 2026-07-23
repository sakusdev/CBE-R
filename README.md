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
- GitHub Actions typecheck, test, package build, and artifact upload

## Requirements

Node.js 20 or newer.

```bash
npm install
npm run check
npm run build
```

## Capture format

CBE-R deliberately separates packet capture from conversion. Any permitted capture adapter can produce this stable JSON format:

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

```bash
node dist/src/cli.js export \
  --input capture.json \
  --output building.nbt \
  --from 100,64,100 \
  --to 140,100,140 \
  --include-entities
```

Installed as a package, the command is `cbe-r`:

```bash
cbe-r export --input capture.json --output building.nbt --from 100,64,100 --to 140,100,140
```

Options:

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

A live Bedrock network adapter is not bundled yet. Bedrock login, encryption, compression, version negotiation, and subchunk packet decoding change across game versions and should be implemented as a separately versioned adapter. The conversion and export pipeline is ready to consume its normalized output.

Conversion coverage is intentionally conservative. Unsupported stateful blocks are reported through barrier replacement or strict errors rather than silently producing an incorrect Java block.

## License

Mozilla Public License 2.0. See [LICENSE](LICENSE).
