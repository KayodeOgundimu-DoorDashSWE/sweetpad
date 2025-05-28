import * as vscode from "vscode";

export type QuickPickItemRow<T> = vscode.QuickPickItem & { context: T };
export type QuickPickItemSeparator = vscode.QuickPickItem & { kind: vscode.QuickPickItemKind.Separator };
export type QuickPickItem<T> = QuickPickItemRow<T> | QuickPickItemSeparator;

/**
 * Shows a quick pick dialog with the given options.
 * @param options - The options for the quick pick dialog.
 * @returns A promise that resolves with the selected item label.
 */
export async function showQuickPick<T>(options: {
  title: string;
  items: QuickPickItem<T>[];
}): Promise<QuickPickItemRow<T>> {
  const pick = vscode.window.createQuickPick<QuickPickItem<T>>();

  pick.items = options.items;
  pick.title = options.title;
  pick.placeholder = options.title;

  pick.show();

  return new Promise((resolve, reject) => {
    pick.onDidAccept(() => {
      const selected = pick.selectedItems[0];

      // I'm not sure if it's possible to select a separator, but just in case and to please the TypeScript checker
      if (!selected || selected?.kind === vscode.QuickPickItemKind.Separator) {
        reject(new Error("No item selected"));
      } else {
        resolve(selected);
      }
      pick.dispose();
    });
  });
}

export async function showInputBox(options: {
  title: string;
  value?: string;
}): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: options.title,
    value: options.value,
  });
}
