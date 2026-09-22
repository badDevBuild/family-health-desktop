import { resolve } from 'node:path';
import { materializeAssessmentV3SyntheticCases } from '../packages/evaluation/src/assessment-v3-cases.ts';

const destination = process.argv.slice(2).find((argument) => argument !== '--');
if (!destination) throw new Error('请提供输出目录，例如：pnpm assessment:materialize -- /tmp/family-health-assessment-v3');
const outputDirectory = resolve(destination);
const receipt = materializeAssessmentV3SyntheticCases(outputDirectory);
process.stdout.write(`${JSON.stringify({ outputDirectory, ...receipt, clinicalQualityStatus: 'NOT_RUN' }, null, 2)}\n`);
