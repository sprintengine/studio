import { cp, mkdir, rename, writeFile } from 'fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
function normalizeNewWorkspaceFolderName(rawName) {
    const name = rawName.trim();
    if (!name || name === '.' || name === '..' || /[/\\]/.test(name)) {
        throw new Error('Enter a valid folder name.');
    }
    if (/[\u0000-\u001f<>:"|?*]/u.test(name)) {
        throw new Error('Folder names cannot contain control characters or <>:"|?*.');
    }
    if (/[. ]$/u.test(name)) {
        throw new Error('Folder names cannot end with a period or space.');
    }
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(name)) {
        throw new Error('That folder name is reserved by Windows.');
    }
    return name;
}
function normalizeRenamedFileSystemEntryName(rawName) {
    if (/[. ]$/u.test(rawName)) {
        throw new Error('File and folder names cannot end with a period or space.');
    }
    const name = rawName.trim();
    if (!name || name === '.' || name === '..' || /[/\\]/.test(name)) {
        throw new Error('Enter a valid file or folder name.');
    }
    if (/[\u0000-\u001f<>:"|?*]/u.test(name)) {
        throw new Error('File and folder names cannot contain control characters or <>:"|?*.');
    }
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(name)) {
        throw new Error('That file or folder name is reserved by Windows.');
    }
    return name;
}
function isPathInsideOrEqual(childPath, parentPath) {
    const child = resolve(childPath);
    const parent = resolve(parentPath);
    const rel = relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
export function registerFilesystemMutationIpc(ipcMain, deps) {
    ipcMain.handle('fs:writefile', async (_, filePath, content) => {
        await deps.assertNotDirectSprintEngineStateMutation(filePath);
        await writeFile(filePath, content, 'utf-8');
    });
    ipcMain.handle('fs:write-binary-file', async (_, filePath, base64Content) => {
        await deps.assertNotDirectSprintEngineStateMutation(filePath);
        await writeFile(filePath, Buffer.from(base64Content, 'base64'));
    });
    ipcMain.handle('fs:create-file', async (_, parentDir, name) => {
        const filePath = join(parentDir, name);
        await deps.assertNotDirectSprintEngineStateMutation(filePath);
        await writeFile(filePath, '', { encoding: 'utf-8', flag: 'wx' });
        return filePath;
    });
    ipcMain.handle('fs:create-dir', async (_, parentDir, name) => {
        const dirPath = join(parentDir, name);
        await mkdir(dirPath);
        return dirPath;
    });
    ipcMain.handle('fs:ensure-dir', async (_, parentDir, name) => {
        const dirPath = join(parentDir, name);
        await mkdir(dirPath, { recursive: true });
        return dirPath;
    });
    ipcMain.handle('fs:create-workspace-folder', async (_, parentDir, name) => {
        const normalizedName = normalizeNewWorkspaceFolderName(name);
        const dirPath = join(parentDir, normalizedName);
        if (await deps.pathExists(dirPath)) {
            throw new Error(`A folder named "${normalizedName}" already exists.`);
        }
        await mkdir(dirPath);
        return dirPath;
    });
    ipcMain.handle('fs:rename', async (_, sourcePath, nextName) => {
        const normalizedName = normalizeRenamedFileSystemEntryName(nextName);
        const targetPath = join(dirname(sourcePath), normalizedName);
        if (targetPath === sourcePath)
            return targetPath;
        await deps.assertNotDirectSprintEngineStateMutation(sourcePath);
        await deps.assertNotDirectSprintEngineStateMutation(targetPath);
        if (await deps.pathExists(targetPath)) {
            throw new Error(`A file or folder named "${normalizedName}" already exists.`);
        }
        await rename(sourcePath, targetPath);
        return targetPath;
    });
    ipcMain.handle('fs:copy', async (_, sourcePath, destinationDir) => {
        const sourceName = basename(sourcePath);
        const destinationPath = await deps.getUniqueCopyPath(destinationDir, sourceName, sourcePath);
        await deps.assertNotDirectSprintEngineStateMutation(sourcePath);
        await deps.assertNotDirectSprintEngineStateMutation(destinationPath);
        await cp(sourcePath, destinationPath, {
            errorOnExist: true,
            force: false,
            recursive: true,
        });
        return destinationPath;
    });
    ipcMain.handle('fs:copy-into', async (_, sourcePath, destinationDir, options) => {
        const destinationPath = join(destinationDir, basename(sourcePath));
        const overwrite = options?.overwrite === true;
        await deps.assertNotDirectSprintEngineStateMutation(sourcePath);
        await deps.assertNotDirectSprintEngineStateMutation(destinationPath);
        if (!overwrite && await deps.pathExists(destinationPath)) {
            throw new Error(`A file or folder named "${basename(sourcePath)}" already exists.`);
        }
        await cp(sourcePath, destinationPath, {
            errorOnExist: !overwrite,
            force: overwrite,
            recursive: true,
        });
        return destinationPath;
    });
    ipcMain.handle('fs:move', async (_, sourcePath, destinationDir) => {
        if (isPathInsideOrEqual(destinationDir, sourcePath)) {
            throw new Error('Cannot move a file or folder into itself.');
        }
        const sourceName = basename(sourcePath);
        const destinationPath = join(destinationDir, sourceName);
        if (destinationPath === sourcePath)
            return sourcePath;
        await deps.assertNotDirectSprintEngineStateMutation(sourcePath);
        await deps.assertNotDirectSprintEngineStateMutation(destinationPath);
        if (await deps.pathExists(destinationPath)) {
            throw new Error(`A file or folder named "${sourceName}" already exists.`);
        }
        await rename(sourcePath, destinationPath);
        return destinationPath;
    });
    ipcMain.handle('fs:delete', async (_, targetPath) => {
        await deps.trashItem(targetPath);
    });
}
