import type { Filesystem, Sandbox, SandboxConnectOpts, SandboxOpts } from 'e2b';
import { randomUUID } from 'node:crypto';

import { isAbortError, raceWithAbort } from '../../sdk/abort';
import type {
	AbortableOptions,
	CommandResult,
	ExecuteCommandOptions,
	ProviderStatus,
	SandboxInfo,
} from '../types';
import { BaseSandbox } from './base-sandbox';
import { SandboxAcquisitionError } from './errors';
import { loadE2b } from './lazy-e2b';
import type { Logger } from './logger';
import { toShellCommand } from './shell-command';

const E2B_SANDBOX_IDENTITY_METADATA_KEY = 'n8n_sandbox_id';
const E2B_HOME_DIR = '/home/user';
const E2B_WORKSPACE_DIR = `${E2B_HOME_DIR}/workspace`;

export interface E2bSandboxOptions {
	/** Deterministic sandbox identity stored in E2B metadata for reconnection. */
	id?: string;
	apiKey?: string;
	template?: string;
	domain?: string;
	timeout?: number;
	ephemeral?: boolean;
	allowInternetAccess?: boolean;
	env?: Record<string, string>;
	metadata?: Record<string, string>;
	logger?: Logger;
}

function isSandboxGoneOrPaused(error: unknown): boolean {
	const { SandboxNotFoundError, SandboxNotRunningError, SandboxUnreachableError } = loadE2b();
	return (
		error instanceof SandboxNotFoundError ||
		error instanceof SandboxNotRunningError ||
		error instanceof SandboxUnreachableError
	);
}

function isSandboxNotFound(error: unknown): boolean {
	const { SandboxNotFoundError, NotFoundError } = loadE2b();
	return error instanceof SandboxNotFoundError || error instanceof NotFoundError;
}

/** Native agents sandbox adapter backed by the E2B SDK. */
export class E2bSandbox extends BaseSandbox {
	readonly id: string;

	readonly name = 'E2bSandbox';

	readonly provider = 'e2b';

	status: ProviderStatus = 'pending';

	private readonly timeout: number;

	private readonly createdAt = new Date();

	private sandbox?: Sandbox;

	private remoteSandboxId?: string;

	private recoveryPromise?: Promise<void>;

	private remoteAcquired = false;

	constructor(private readonly options: E2bSandboxOptions = {}) {
		super();
		this.id = options.id ?? `e2b-sandbox-${randomUUID()}`;
		this.timeout = options.timeout ?? 300_000;
	}

	get instance(): Sandbox {
		if (!this.sandbox) {
			throw new Error(`E2B sandbox "${this.id}" is not running`);
		}
		return this.sandbox;
	}

	override async start(): Promise<void> {
		if (this.sandbox) return;

		try {
			const existing = await this.findAndConnectExistingSandbox();
			if (existing) {
				this.sandbox = existing;
				this.remoteSandboxId = existing.sandboxId;
				this.remoteAcquired = true;
				return;
			}

			const created = await this.createSandbox();
			this.sandbox = created;
			this.remoteSandboxId = created.sandboxId;
			this.remoteAcquired = true;
		} catch (error) {
			throw this.toAcquisitionError(error);
		}
	}

	override async stop(): Promise<void> {
		if (!this.sandbox) return;
		const { Sandbox: E2bSandboxSdk } = loadE2b();
		const sandboxId = this.sandbox.sandboxId;
		try {
			await this.withLifecycleTimeout(E2bSandboxSdk.pause(sandboxId, this.connectionOpts()));
		} catch (error) {
			if (!isSandboxNotFound(error)) throw error;
		}
		this.sandbox = undefined;
	}

	override async destroy(): Promise<void> {
		const { Sandbox: E2bSandboxSdk } = loadE2b();
		const sandboxId =
			this.sandbox?.sandboxId ?? (this.remoteAcquired ? this.remoteSandboxId : undefined);
		if (sandboxId) {
			try {
				await this.withLifecycleTimeout(E2bSandboxSdk.kill(sandboxId, this.connectionOpts()));
			} catch (error) {
				if (!isSandboxNotFound(error)) throw error;
			}
		}
		this.sandbox = undefined;
		this.remoteSandboxId = undefined;
	}

	/**
	 * Delete the remote E2B sandbox matching this instance's deterministic identity,
	 * whether or not this instance created it.
	 */
	override async deleteRemote(): Promise<void> {
		const { Sandbox: E2bSandboxSdk } = loadE2b();
		const knownId = this.sandbox?.sandboxId ?? this.remoteSandboxId;
		try {
			if (knownId) {
				await this.withLifecycleTimeout(E2bSandboxSdk.kill(knownId, this.connectionOpts()));
			} else if (this.options.id) {
				const matches = await this.listByIdentity();
				for (const item of matches) {
					await this.withLifecycleTimeout(
						E2bSandboxSdk.kill(item.sandboxId, this.connectionOpts()),
					);
				}
			}
		} catch (error) {
			if (!isSandboxNotFound(error)) throw error;
		}
		this.sandbox = undefined;
		this.remoteSandboxId = undefined;
	}

	override async executeCommand(
		command: string,
		args: string[] = [],
		options?: ExecuteCommandOptions,
	): Promise<CommandResult> {
		const { CommandExitError, TimeoutError, SandboxNotRunningError, SandboxUnreachableError } =
			loadE2b();

		return await raceWithAbort(async () => {
			return await this.recoverAndRetry(async () => {
				await this.ensureRunning({ abortSignal: options?.abortSignal });
				const startedAt = Date.now();
				const fullCommand = toShellCommand(command, args);
				try {
					const result = await this.instance.commands.run(fullCommand, {
						cwd: options?.cwd,
						envs: this.compactEnv(options?.env),
						timeoutMs: options?.timeout ?? this.timeout,
						signal: options?.abortSignal,
						onStdout: options?.onStdout,
						onStderr: options?.onStderr,
					});

					return {
						command,
						args,
						success: result.exitCode === 0,
						exitCode: result.exitCode,
						stdout: result.stdout,
						stderr: result.stderr,
						executionTimeMs: Date.now() - startedAt,
					};
				} catch (error) {
					if (error instanceof CommandExitError) {
						return {
							command,
							args,
							success: false,
							exitCode: error.exitCode,
							stdout: error.stdout ?? '',
							stderr: error.stderr ?? '',
							executionTimeMs: Date.now() - startedAt,
						};
					}
					if (
						error instanceof TimeoutError &&
						!(error instanceof SandboxNotRunningError) &&
						!(error instanceof SandboxUnreachableError)
					) {
						return {
							command,
							args,
							success: false,
							exitCode: 124,
							stdout: '',
							stderr: error.message,
							executionTimeMs: Date.now() - startedAt,
							timedOut: true,
						};
					}
					throw error;
				}
			});
		}, options?.abortSignal);
	}

	/**
	 * Run a filesystem operation against the live E2B Filesystem handle, ensuring the
	 * sandbox is running first and recovering once if the remote expired or paused.
	 */
	async withFilesystem<T>(
		op: (fs: Filesystem) => Promise<T>,
		options?: AbortableOptions,
	): Promise<T> {
		return await raceWithAbort(async () => {
			return await this.recoverAndRetry(async () => {
				await this.ensureRunning({ abortSignal: options?.abortSignal });
				return await op(this.instance.files);
			});
		}, options?.abortSignal);
	}

	getInfo(): SandboxInfo {
		return {
			id: this.id,
			name: this.name,
			provider: this.provider,
			status: this.status,
			createdAt: this.createdAt,
			metadata: {
				workingDirectory: E2B_WORKSPACE_DIR,
				remoteSandboxId: this.remoteSandboxId,
				template: this.options.template,
			},
		};
	}

	override getInstructions(): string {
		return [
			'Cloud sandbox with isolated execution (E2B runtime).',
			`Default working directory: ${E2B_WORKSPACE_DIR}.`,
			`Command timeout: ${Math.ceil(this.timeout / 1000)}s.`,
		].join(' ');
	}

	private connectionOpts(): { apiKey?: string; domain?: string } {
		return {
			...(this.options.apiKey ? { apiKey: this.options.apiKey } : {}),
			...(this.options.domain ? { domain: this.options.domain } : {}),
		};
	}

	private async listByIdentity() {
		const { Sandbox: E2bSandboxSdk } = loadE2b();
		const paginator = E2bSandboxSdk.list({
			...this.connectionOpts(),
			query: {
				metadata: { [E2B_SANDBOX_IDENTITY_METADATA_KEY]: this.id },
				state: ['running', 'paused'],
			},
			limit: 1,
		});
		return await this.withLifecycleTimeout(paginator.nextItems());
	}

	private async findAndConnectExistingSandbox(): Promise<Sandbox | null> {
		if (!this.options.id && !this.remoteSandboxId) return null;

		const { Sandbox: E2bSandboxSdk } = loadE2b();
		const connectOpts: SandboxConnectOpts = {
			...this.connectionOpts(),
			timeoutMs: this.timeout,
		};

		if (this.remoteSandboxId) {
			try {
				return await this.withLifecycleTimeout(
					E2bSandboxSdk.connect(this.remoteSandboxId, connectOpts),
				);
			} catch (error) {
				if (!isSandboxGoneOrPaused(error)) throw error;
				this.remoteSandboxId = undefined;
			}
		}

		if (!this.options.id) return null;

		const matches = await this.listByIdentity();
		const existing = matches[0];
		if (!existing) return null;

		try {
			return await this.withLifecycleTimeout(
				E2bSandboxSdk.connect(existing.sandboxId, connectOpts),
			);
		} catch (error) {
			if (isSandboxGoneOrPaused(error)) return null;
			throw error;
		}
	}

	private async createSandbox(): Promise<Sandbox> {
		const { Sandbox: E2bSandboxSdk } = loadE2b();
		const opts: SandboxOpts = {
			...this.connectionOpts(),
			timeoutMs: this.timeout,
			envs: this.options.env,
			metadata: {
				...this.options.metadata,
				[E2B_SANDBOX_IDENTITY_METADATA_KEY]: this.id,
			},
			...(this.options.allowInternetAccess !== undefined
				? { allowInternetAccess: this.options.allowInternetAccess }
				: {}),
			...(this.options.ephemeral === true
				? { lifecycle: { onTimeout: 'kill' } }
				: this.options.ephemeral === false
					? { lifecycle: { onTimeout: 'pause', autoResume: true } }
					: {}),
		};

		const template = this.options.template?.trim();
		const creation = template ? E2bSandboxSdk.create(template, opts) : E2bSandboxSdk.create(opts);
		return await this.withLifecycleTimeout(creation);
	}

	private toAcquisitionError(error: unknown): unknown {
		if (isAbortError(error) || error instanceof SandboxAcquisitionError) return error;
		const { SandboxError, AuthenticationError } = loadE2b();
		if (!(error instanceof SandboxError) && !(error instanceof AuthenticationError)) return error;
		const failureClass = error.constructor.name;
		this.options.logger?.warn('E2B sandbox acquisition failed', {
			sandboxId: this.id,
			failureClass,
			error: error.message,
		});
		return new SandboxAcquisitionError(
			`Failed to acquire E2B sandbox: ${error.message}`,
			failureClass,
			{
				cause: error,
			},
		);
	}

	private resetLocalHandle(): void {
		this.sandbox = undefined;
		this.markNeedsStart();
	}

	private async recoverAndRetry<T>(op: () => Promise<T>): Promise<T> {
		try {
			return await op();
		} catch (error) {
			if (isAbortError(error)) throw error;
			if (!isSandboxGoneOrPaused(error)) throw error;
			await this.recover();
			return await op();
		}
	}

	private async recover(): Promise<void> {
		this.recoveryPromise ??= (async () => {
			this.resetLocalHandle();
			await this.ensureRunning();
		})().finally(() => {
			this.recoveryPromise = undefined;
		});
		await this.recoveryPromise;
	}

	private async withLifecycleTimeout<T>(operation: Promise<T>): Promise<T> {
		return await raceWithAbort(operation, AbortSignal.timeout(this.timeout));
	}

	private compactEnv(env: NodeJS.ProcessEnv | undefined): Record<string, string> | undefined {
		const merged = {
			...this.options.env,
			...env,
		};
		const entries = Object.entries(merged).filter(
			(entry): entry is [string, string] => typeof entry[1] === 'string',
		);
		return entries.length > 0 ? Object.fromEntries(entries) : undefined;
	}
}
