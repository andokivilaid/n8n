import type { Filesystem } from 'e2b';

import { BaseFilesystem, type BaseFilesystemOptions } from './base-filesystem';
import type { E2bSandbox } from '../sandbox/e2b-sandbox';
import { loadE2b } from '../sandbox/lazy-e2b';
import type {
	AbortableOptions,
	AppendOptions,
	CopyOptions,
	FileContent,
	FileEntry,
	FileStat,
	ListOptions,
	MkdirOptions,
	ProviderStatus,
	ReadOptions,
	RemoveOptions,
	WriteOptions,
} from '../types';

function toUploadBuffer(content: FileContent): Buffer {
	return typeof content === 'string' ? Buffer.from(content, 'utf-8') : Buffer.from(content);
}

function isFileNotFound(error: unknown): boolean {
	const { FileNotFoundError, NotFoundError, SandboxNotFoundError } = loadE2b();
	if (error instanceof SandboxNotFoundError) return false;
	return error instanceof FileNotFoundError || error instanceof NotFoundError;
}

/** Native agents filesystem adapter backed by the E2B SDK Filesystem API. */
export class E2bFilesystem extends BaseFilesystem {
	readonly id: string;

	readonly name = 'E2bFilesystem';

	readonly provider = 'e2b';

	status: ProviderStatus = 'pending';

	constructor(
		private readonly sandbox: E2bSandbox,
		options?: BaseFilesystemOptions,
	) {
		super(options);
		this.id = `e2b-fs-${sandbox.id}`;
	}

	private async withFs<T>(
		op: (fs: Filesystem) => Promise<T>,
		abortSignal?: AbortSignal,
	): Promise<T> {
		await this.ensureReady();
		return await this.sandbox.withFilesystem(op, { abortSignal });
	}

	async readFile(path: string, options?: ReadOptions): Promise<string | Buffer> {
		return await this.withFs(async (fs) => {
			const bytes = await fs.read(path, { format: 'bytes', signal: options?.abortSignal });
			const buffer = Buffer.from(bytes);
			if (options?.encoding) {
				return buffer.toString(options.encoding);
			}
			return buffer;
		}, options?.abortSignal);
	}

	async writeFile(path: string, content: FileContent, options?: WriteOptions): Promise<void> {
		await this.withFs(async (fs) => {
			if (
				options?.overwrite === false &&
				(await fs.exists(path, { signal: options?.abortSignal }))
			) {
				throw new Error(`File already exists: ${path}`);
			}
			await fs.write(path, toUploadBuffer(content), { signal: options?.abortSignal });
		}, options?.abortSignal);
	}

	/** Upload many files in one request. E2B creates missing parent directories. */
	async writeFiles(
		files: Array<{ path: string; content: FileContent }>,
		options?: AbortableOptions,
	): Promise<void> {
		await this.withFs(
			async (fs) =>
				await fs.writeFiles(
					files.map(({ path, content }) => ({
						path,
						data: toUploadBuffer(content),
					})),
					{ signal: options?.abortSignal },
				),
			options?.abortSignal,
		);
	}

	async appendFile(path: string, content: FileContent, options?: AppendOptions): Promise<void> {
		await this.withFs(async (fs) => {
			let existing: Buffer;
			try {
				const bytes = await fs.read(path, { format: 'bytes', signal: options?.abortSignal });
				existing = Buffer.from(bytes);
			} catch (error) {
				// Only a missing file starts empty; sandbox errors must bubble up for recovery.
				if (!isFileNotFound(error)) throw error;
				existing = Buffer.alloc(0);
			}
			await fs.write(path, Buffer.concat([existing, toUploadBuffer(content)]), {
				signal: options?.abortSignal,
			});
		}, options?.abortSignal);
	}

	async deleteFile(path: string, options?: RemoveOptions): Promise<void> {
		await this.withFs(async (fs) => {
			try {
				await fs.remove(path, { signal: options?.abortSignal });
			} catch (error) {
				if (options?.force && isFileNotFound(error)) return;
				throw error;
			}
		}, options?.abortSignal);
	}

	async copyFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
		await this.withFs(async (fs) => {
			if (
				options?.overwrite === false &&
				(await fs.exists(dest, { signal: options?.abortSignal }))
			) {
				throw new Error(`Destination already exists: ${dest}`);
			}
			const bytes = await fs.read(src, { format: 'bytes', signal: options?.abortSignal });
			await fs.write(dest, Buffer.from(bytes), { signal: options?.abortSignal });
		}, options?.abortSignal);
	}

	async moveFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
		await this.withFs(
			async (fs) => await fs.rename(src, dest, { signal: options?.abortSignal }),
			options?.abortSignal,
		);
	}

	async mkdir(path: string, options?: MkdirOptions): Promise<void> {
		await this.withFs(
			async (fs) => await fs.makeDir(path, { signal: options?.abortSignal }),
			options?.abortSignal,
		);
	}

	async rmdir(path: string, options?: RemoveOptions): Promise<void> {
		await this.deleteFile(path, options);
	}

	async readdir(path: string, options?: ListOptions): Promise<FileEntry[]> {
		const { FileType } = loadE2b();
		return await this.withFs(async (fs) => {
			const entries = await fs.list(path, {
				depth: 1,
				signal: options?.abortSignal,
			});
			return entries.map((entry) => ({
				name: entry.name,
				type: entry.type === FileType.DIR ? ('directory' as const) : ('file' as const),
				size: entry.size,
			}));
		}, options?.abortSignal);
	}

	async exists(path: string, options?: AbortableOptions): Promise<boolean> {
		return await this.withFs(
			async (fs) => await fs.exists(path, { signal: options?.abortSignal }),
			options?.abortSignal,
		);
	}

	async stat(path: string, options?: AbortableOptions): Promise<FileStat> {
		const { FileType } = loadE2b();
		return await this.withFs(async (fs) => {
			const info = await fs.getInfo(path, { signal: options?.abortSignal });
			const modifiedAt = info.modifiedTime ?? new Date(0);
			return {
				name: info.name || path.split('/').pop() || '',
				path: info.path || path,
				type: info.type === FileType.DIR ? 'directory' : 'file',
				size: info.size,
				createdAt: modifiedAt,
				modifiedAt,
			};
		}, options?.abortSignal);
	}
}
