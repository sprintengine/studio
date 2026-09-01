import { stat } from 'fs/promises';
import { join, parse } from 'path';
export async function getUniqueCopyPath(destinationDir, sourceName, sourcePath, pathExists) {
    const base = await buildCopyBaseName(sourceName, sourcePath);
    let attempt = 0;
    while (true) {
        const candidateName = attempt === 0 ? base.first : base.next(attempt + 1);
        const candidatePath = join(destinationDir, candidateName);
        if (!(await pathExists(candidatePath))) {
            return candidatePath;
        }
        attempt += 1;
    }
}
async function buildCopyBaseName(sourceName, sourcePath) {
    const sourceStats = await stat(sourcePath);
    const sourceIsDirectory = sourceStats.isDirectory();
    if (sourceIsDirectory) {
        return {
            first: `${sourceName} copy`,
            next: (count) => `${sourceName} copy ${count}`,
        };
    }
    const parsed = parse(sourceName);
    return {
        first: `${parsed.name} copy${parsed.ext}`,
        next: (count) => `${parsed.name} copy ${count}${parsed.ext}`,
    };
}
