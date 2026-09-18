import { resolve } from 'node:path';
import {
  createSyntheticGoldDataset,
  materializeSyntheticBinaryFixtures,
  materializeSyntheticGoldDataset
} from '../packages/evaluation/src/index.ts';

const destination = process.argv.slice(2).find((argument) => argument !== '--');
if (!destination) {
  throw new Error('请提供输出目录，例如：pnpm gold:materialize -- /tmp/family-health-gold');
}

const outputDirectory = resolve(destination);
const result = materializeSyntheticGoldDataset(outputDirectory);
const fixtures = await materializeSyntheticBinaryFixtures(createSyntheticGoldDataset(), outputDirectory);
process.stdout.write(`${JSON.stringify({
  outputDirectory,
  ...result,
  binaryFixtures: {
    count: fixtures.files.length,
    formats: Object.fromEntries([...new Set(fixtures.files.map((file) => file.format))].map((format) => [format, fixtures.files.filter((file) => file.format === format).length]))
  }
}, null, 2)}\n`);
