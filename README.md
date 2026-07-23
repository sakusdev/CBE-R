# CBE-R

CBE-R is an experimental toolchain for capturing structures visible to a Minecraft Bedrock Edition client and exporting them as Minecraft Java Edition structure NBT files.

## Current status

The first milestone provides a dependency-free TypeScript encoder for Java Edition structure NBT:

- Java block-state palette generation
- block position and palette-index encoding
- uncompressed and gzip-compressed NBT output
- bounds validation

Bedrock network capture and Bedrock-to-Java block-state conversion are not implemented yet.

## Development

Requires Node.js 20 or newer.

```bash
npm install
npm test
```

## Example

```ts
import { writeFile } from "node:fs/promises";
import { encodeJavaStructureGzip } from "cbe-r";

const output = encodeJavaStructureGzip({
  dataVersion: 3955,
  size: [1, 1, 1],
  blocks: [
    {
      pos: [0, 0, 0],
      state: { name: "minecraft:stone" },
    },
  ],
});

await writeFile("building.nbt", output);
```

## Roadmap

1. Bedrock block-state normalization
2. Bedrock-to-Java mapping tables
3. chunk capture/import interface
4. block-entity support
5. CLI range selection and `.nbt` export

## License

Mozilla Public License 2.0. See [LICENSE](LICENSE).
