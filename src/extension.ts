import * as vscode from 'vscode';
import * as path from 'path';
import { IDENT_RE, PACKAGE_RE, findSourceRootPath, parsePackage, transformSource } from './transform';

interface PkgItem extends vscode.QuickPickItem {
  pkg: string;
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('copyClass.copy', async (uri?: vscode.Uri) => {
      try {
        await copyClass(uri);
      } catch (err) {
        vscode.window.showErrorMessage(`Copy Class 실패: ${err instanceof Error ? err.message : String(err)}`);
      }
    })
  );
}

export function deactivate(): void {}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function listClassNames(dir: vscode.Uri): Promise<string[]> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    return entries
      .filter(([name, type]) => (type & vscode.FileType.File) !== 0 && name.endsWith('.java') && name !== 'package-info.java')
      .map(([name]) => name.slice(0, -'.java'.length));
  } catch {
    return [];
  }
}

/** Packages (dotted names) under the source root that contain at least one .java file. */
async function listPackages(root: vscode.Uri): Promise<string[]> {
  const result: string[] = [];
  const stack: Array<{ uri: vscode.Uri; pkg: string }> = [{ uri: root, pkg: '' }];
  let visited = 0;
  while (stack.length > 0 && visited < 5000) {
    const { uri, pkg } = stack.pop()!;
    visited++;
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(uri);
    } catch {
      continue;
    }
    let hasJava = false;
    for (const [name, type] of entries) {
      if (type & vscode.FileType.Directory) {
        if (!IDENT_RE.test(name)) {
          continue; // .git, META-INF, etc. can't be package segments
        }
        stack.push({ uri: vscode.Uri.joinPath(uri, name), pkg: pkg ? `${pkg}.${name}` : name });
      } else if (name.endsWith('.java')) {
        hasJava = true;
      }
    }
    if (hasJava && pkg) {
      result.push(pkg);
    }
  }
  return result.sort();
}

function pickPackage(packages: string[], current: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<PkgItem>();
    qp.title = 'Copy Class - 대상 패키지';
    qp.placeholder = '패키지를 선택하거나 새 패키지명을 입력하세요 (예: com.foo.aaa002)';
    const base = current ? [current, ...packages.filter((p) => p !== current)] : packages;
    const toItems = (value: string): PkgItem[] => {
      const items: PkgItem[] = base.map((p) => ({
        label: p,
        description: p === current ? '(현재 패키지)' : undefined,
        pkg: p,
      }));
      const v = value.trim();
      if (v && !base.includes(v)) {
        items.unshift({ label: `$(add) ${v}`, description: '새 패키지', pkg: v, alwaysShow: true });
      }
      return items;
    };
    // Prefill the input with the current package (cursor at the end) so e.g. aaa001 -> aaa002 only
    // takes a backspace and a retype instead of typing the whole package name again.
    qp.value = current;
    qp.items = toItems(current);
    qp.onDidChangeValue((v) => {
      qp.items = toItems(v);
    });
    qp.onDidAccept(() => {
      resolve(qp.selectedItems[0]?.pkg);
      qp.hide();
    });
    qp.onDidHide(() => {
      resolve(undefined);
      qp.dispose();
    });
    qp.show();
  });
}

async function copyClass(arg?: vscode.Uri): Promise<void> {
  const src = arg ?? vscode.window.activeTextEditor?.document.uri;
  if (!src || !src.path.endsWith('.java')) {
    vscode.window.showWarningMessage('Java 파일(.java)에서 실행해 주세요.');
    return;
  }

  const srcDoc = await vscode.workspace.openTextDocument(src);
  if (srcDoc.isDirty) {
    const choice = await vscode.window.showWarningMessage(
      '저장되지 않은 변경 사항이 있습니다. 저장한 뒤 복사할까요?',
      { modal: true },
      '저장 후 복사'
    );
    if (choice !== '저장 후 복사') {
      return;
    }
    await srcDoc.save();
  }

  const oldName = path.posix.basename(src.path, '.java');
  const oldPkg = parsePackage(srcDoc.getText());
  const srcDir = src.with({ path: path.posix.dirname(src.path) });
  const rootPath = findSourceRootPath(srcDir.path, oldPkg);
  if (rootPath === undefined) {
    vscode.window.showErrorMessage(
      `패키지 선언(${oldPkg})과 파일 위치가 맞지 않아 소스 루트를 찾을 수 없습니다.`
    );
    return;
  }
  const root = src.with({ path: rootPath });

  const newName = await vscode.window.showInputBox({
    title: 'Copy Class - 새 클래스명',
    value: oldName,
    valueSelection: [0, oldName.length],
    validateInput: (v) => (IDENT_RE.test(v.trim()) ? undefined : '올바른 Java 식별자가 아닙니다.'),
  });
  if (newName === undefined) {
    return;
  }
  const className = newName.trim();

  const packages = await listPackages(root);
  const newPkg = await pickPackage(packages, oldPkg);
  if (newPkg === undefined) {
    return;
  }
  if (!PACKAGE_RE.test(newPkg)) {
    vscode.window.showErrorMessage(`올바르지 않은 패키지명입니다: ${newPkg}`);
    return;
  }
  if (className === oldName && newPkg === oldPkg) {
    vscode.window.showWarningMessage('이름과 패키지가 원본과 같아서 복사할 수 없습니다.');
    return;
  }

  const targetDir = vscode.Uri.joinPath(root, ...newPkg.split('.'));
  const dst = vscode.Uri.joinPath(targetDir, `${className}.java`);
  if (await exists(dst)) {
    vscode.window.showErrorMessage(`이미 존재하는 파일입니다: ${newPkg}.${className}`);
    return;
  }

  // Copy the raw bytes first (keeps the source file's encoding, e.g. EUC-KR/MS949, intact), then
  // edit the copy through a text document so VSCode saves it back in the same encoding.
  await vscode.workspace.fs.createDirectory(targetDir);
  await vscode.workspace.fs.copy(src, dst, { overwrite: false });

  const siblingClasses = oldPkg && oldPkg !== newPkg ? await listClassNames(srcDir) : [];
  const targetClasses = await listClassNames(targetDir);

  const dstDoc = await vscode.workspace.openTextDocument(dst);
  const original = dstDoc.getText();
  const result = transformSource(original, {
    oldName,
    newName: className,
    oldPkg,
    newPkg,
    siblingClasses,
    targetClasses,
    eol: dstDoc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
  });

  const edit = new vscode.WorkspaceEdit();
  edit.replace(dst, new vscode.Range(dstDoc.positionAt(0), dstDoc.positionAt(original.length)), result.text);
  await vscode.workspace.applyEdit(edit);
  await dstDoc.save();
  await vscode.window.showTextDocument(dstDoc);

  const notes: string[] = [];
  if (result.renamed > 0) {
    notes.push(`클래스명 ${result.renamed}곳 변경`);
  }
  if (result.addedImports.length > 0) {
    notes.push(`import 추가: ${result.addedImports.join(', ')}`);
  }
  let message = `복사 완료: ${oldPkg ? oldPkg + '.' : ''}${oldName} → ${newPkg}.${className}`;
  if (notes.length > 0) {
    message += ` (${notes.join(' / ')})`;
  }
  if (result.skippedImports.length > 0) {
    vscode.window.showWarningMessage(
      `${message}\n대상 패키지에 같은 이름의 클래스가 있어 import를 추가하지 않았습니다: ${result.skippedImports.join(', ')} - 직접 확인해 주세요.`
    );
  } else {
    vscode.window.showInformationMessage(message);
  }
}
