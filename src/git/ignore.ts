import ignore, { type Ignore } from 'ignore'

type ReadText = (path: string) => Promise<string | null>

interface Level {
  base: string
  rules: Ignore
}

/** Evaluates .git/info/exclude and nested .gitignore files, caching each file's rules. */
export class IgnoreRules {
  private readonly readText: ReadText
  private readonly levels = new Map<string, Promise<Level[]>>()
  private excludes: Promise<Level[]> | null = null

  constructor(readText: ReadText) {
    this.readText = readText
  }

  async isIgnored(path: string, isDirectory: boolean): Promise<boolean> {
    const parts = path.split('/')
    const dirs = parts.slice(0, -1)
    const levels = [...(await this.infoExcludes())]
    for (let depth = 0; depth <= dirs.length; depth++) {
      levels.push(...(await this.levelFor(dirs.slice(0, depth).join('/'))))
    }

    let ignored = false
    for (const { base, rules } of levels) {
      const relative = base ? path.slice(base.length + 1) : path
      const result = rules.test(isDirectory ? `${relative}/` : relative)
      if (result.ignored) ignored = true
      else if (result.unignored) ignored = false
    }
    return ignored
  }

  private infoExcludes(): Promise<Level[]> {
    this.excludes ??= this.load('', '.git/info/exclude')
    return this.excludes
  }

  private levelFor(dir: string): Promise<Level[]> {
    let level = this.levels.get(dir)
    if (!level) {
      level = this.load(dir, dir ? `${dir}/.gitignore` : '.gitignore')
      this.levels.set(dir, level)
    }
    return level
  }

  private async load(base: string, file: string): Promise<Level[]> {
    const text = await this.readText(file)
    return text ? [{ base, rules: ignore().add(text) }] : []
  }
}
