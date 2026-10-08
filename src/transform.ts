/**
 * Pure text logic for "Copy Class" - no vscode imports, so it can be unit tested with plain node.
 */

export const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
export const PACKAGE_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;

const PACKAGE_DECL = /^[ \t]*package\s+([\w.$]+)\s*;/m;

export interface TransformContext {
  oldName: string;
  newName: string;
  oldPkg: string;
  newPkg: string;
  /** Simple names of the classes living in the source package (for same-package references). */
  siblingClasses: string[];
  /** Simple names of the classes already living in the target package. */
  targetClasses: string[];
  eol: string;
}

export interface TransformResult {
  text: string;
  /** How many occurrences of the old class name were renamed (package/import lines excluded). */
  renamed: number;
  /** Same-package classes that now need an import because the copy lives in another package. */
  addedImports: string[];
  /** Same-package classes used by the copy that were NOT imported, because the target package
   *  already has a class with that simple name (would silently bind to the wrong class). */
  skippedImports: string[];
}

export function parsePackage(text: string): string {
  const m = PACKAGE_DECL.exec(text);
  return m ? m[1] : '';
}

/** Given the directory holding a .java file and its package, returns the source-root directory
 *  (the directory the package path hangs off), or undefined when they don't line up. Paths use
 *  forward slashes (vscode Uri.path). */
export function findSourceRootPath(dirPath: string, pkg: string): string | undefined {
  if (!pkg) {
    return dirPath;
  }
  const suffix = '/' + pkg.replace(/\./g, '/');
  if (dirPath.endsWith(suffix)) {
    return dirPath.slice(0, dirPath.length - suffix.length);
  }
  return undefined;
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replacePackage(src: string, c: TransformContext): string {
  const m = PACKAGE_DECL.exec(src);
  if (!m) {
    return `package ${c.newPkg};${c.eol}${c.eol}${src}`;
  }
  const declStart = m.index + m[0].indexOf('package');
  const declEnd = m.index + m[0].length;
  return src.slice(0, declStart) + `package ${c.newPkg};` + src.slice(declEnd);
}

function parseImports(text: string): { simpleNames: Set<string>; wildcards: Set<string> } {
  const simpleNames = new Set<string>();
  const wildcards = new Set<string>();
  const re = /^[ \t]*import\s+(static\s+)?([\w.$]+(?:\.\*)?)\s*;/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) {
      continue; // static import - not a type import
    }
    const fq = m[2];
    if (fq.endsWith('.*')) {
      wildcards.add(fq.slice(0, -2));
    } else {
      simpleNames.add(fq.slice(fq.lastIndexOf('.') + 1));
    }
  }
  return { simpleNames, wildcards };
}

/** Blanks out comments and string/char literals so a class name that only appears in a comment
 *  or a log message isn't mistaken for a real type reference. */
function stripCommentsAndStrings(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'/g, ' ');
}

function insertImports(text: string, importLines: string[], eol: string): string {
  const importRe = /^[ \t]*import\s[^;]*;[^\r\n]*/gm;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(text)) !== null) {
    last = m;
  }
  if (last) {
    const idx = last.index + last[0].length;
    return text.slice(0, idx) + eol + importLines.join(eol) + text.slice(idx);
  }
  const pm = PACKAGE_DECL.exec(text);
  const idx = pm ? pm.index + pm[0].length : 0;
  return text.slice(0, idx) + eol + eol + importLines.join(eol) + text.slice(idx);
}

export function transformSource(src: string, c: TransformContext): TransformResult {
  let text = replacePackage(src, c);

  // Rename the class everywhere except the package/import lines.
  let renamed = 0;
  if (c.newName !== c.oldName) {
    const re = new RegExp(`(?<![\\w$])${escapeRe(c.oldName)}(?![\\w$])`, 'g');
    text = text
      .split(/(\r\n|\n)/)
      .map((part) => {
        if (/^\s*(package|import)\s/.test(part)) {
          return part;
        }
        return part.replace(re, () => {
          renamed++;
          return c.newName;
        });
      })
      .join('');
  }

  // Classes that used to be visible without an import (same package) now need one.
  const addedImports: string[] = [];
  const skippedImports: string[] = [];
  if (c.oldPkg && c.oldPkg !== c.newPkg) {
    const existing = parseImports(text);
    if (!existing.wildcards.has(c.oldPkg)) {
      const body = stripCommentsAndStrings(
        text
          .split(/\r?\n/)
          .filter((l) => !/^\s*(package|import)\s/.test(l))
          .join('\n')
      );
      const candidates = [...new Set(c.siblingClasses)].filter(
        (n) => IDENT_RE.test(n) && n !== c.oldName && n !== c.newName && !existing.simpleNames.has(n)
      );
      for (const name of candidates) {
        const used = new RegExp(`(?<![\\w$.])${escapeRe(name)}(?![\\w$])`).test(body);
        if (!used) {
          continue;
        }
        if (c.targetClasses.includes(name)) {
          skippedImports.push(name);
        } else {
          addedImports.push(name);
        }
      }
      if (addedImports.length > 0) {
        text = insertImports(
          text,
          addedImports.map((n) => `import ${c.oldPkg}.${n};`),
          c.eol
        );
      }
    }
  }

  return { text, renamed, addedImports, skippedImports };
}
