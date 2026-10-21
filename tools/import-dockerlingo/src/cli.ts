import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { convertUnit, mapId, trackYaml, type DockerLingoUnit } from './convert.js';

const USAGE = 'usage: import-dockerlingo <units-dir> <out-dir>';
const UNIT_FILE = /^u\d{2}\.json$/;

/**
 * Converts every `uNN.json` in `unitsDir` into `<outDir>/sNN/{section.yaml,lNN.yaml}`
 * and writes `<outDir>/track.yaml`. Relative paths resolve against the directory
 * pnpm was started from (INIT_CWD), not the package directory.
 */
export async function run(argv: string[], out = (line: string) => console.log(line)) {
  const [unitsArg, outArg, ...rest] = argv;
  if (!unitsArg || !outArg || rest.length > 0) {
    out(USAGE);
    return 2;
  }
  const base = process.env.INIT_CWD ?? process.cwd();
  const unitsDir = resolve(base, unitsArg);
  const outDir = resolve(base, outArg);

  const files = (await readdir(unitsDir)).filter((f) => UNIT_FILE.test(f)).sort();
  const sections: string[] = [];
  let lessonCount = 0;
  let taskCount = 0;
  for (const file of files) {
    const unit = JSON.parse(await readFile(join(unitsDir, file), 'utf8')) as DockerLingoUnit;
    const section = mapId(unit.id).split('.')[1]!;
    const converted = convertUnit(unit);
    const sectionDir = join(outDir, section);
    await mkdir(sectionDir, { recursive: true });
    await writeFile(join(sectionDir, 'section.yaml'), converted.sectionYaml);
    for (const lesson of converted.lessons) {
      await writeFile(join(sectionDir, lesson.file), lesson.yaml);
    }
    sections.push(section);
    lessonCount += converted.lessons.length;
    taskCount += unit.lessons.reduce((n, l) => n + l.tasks.length, 0);
  }
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'track.yaml'), trackYaml(sections));
  out(`${sections.length} sections, ${lessonCount} lessons, ${taskCount} tasks → ${outDir}`);
  return 0;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  process.exitCode = await run(process.argv.slice(2));
}
