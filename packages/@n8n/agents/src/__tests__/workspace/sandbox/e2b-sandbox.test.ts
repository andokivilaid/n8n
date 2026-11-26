import { E2bFilesystem } from '../../../workspace/filesystem/e2b-filesystem';
import { E2bSandbox } from '../../../workspace/sandbox/e2b-sandbox';
import { SandboxAcquisitionError } from '../../../workspace/sandbox/errors';

class MockSandboxError extends Error {}
class MockAuthenticationError extends Error {}
class MockTimeoutError extends MockSandboxError {}
class MockNotFoundError extends MockSandboxError {}
class MockFileNotFoundError extends MockNotFoundError {}
class MockSandboxNotFoundError extends MockNotFoundError {}
class MockSandboxNotRunningError extends MockTimeoutError {}
class MockSandboxUnreachableError extends MockTimeoutError {}
class MockCommandExitError extends MockSandboxError {
	readonly exitCode: number;

	readonly stdout: string;

	readonly stderr: string;

	constructor(result: { exitCode: number; stdout: string; stderr: string }) {
		super(`Command exited with code ${result.exitCode}`);
		this.exitCode = result.exitCode;
		this.stdout = result.stdout;
		this.stderr = result.stderr;
	}
}

const mockCreate = vi.fn();
const mockConnect = vi.fn();
const mockList = vi.fn();
const mockKill = vi.fn();
const mockPause = vi.fn();

vi.mock('../../../workspace/sandbox/lazy-e2b', () => ({
	loadE2b: () => ({
		Sandbox: {
			create: mockCreate,
			connect: mockConnect,
			list: mockList,
			kill: mockKill,
			pause: mockPause,
		},
		SandboxError: MockSandboxError,
		AuthenticationError: MockAuthenticationError,
		TimeoutError: MockTimeoutError,
		NotFoundError: MockNotFoundError,
		FileNotFoundError: MockFileNotFoundError,
		SandboxNotFoundError: MockSandboxNotFoundError,
		SandboxNotRunningError: MockSandboxNotRunningError,
		SandboxUnreachableError: MockSandboxUnreachableError,
		CommandExitError: MockCommandExitError,
		FileType: {
			FILE: 'file',
			DIR: 'dir',
			SYMLINK: 'symlink',
		},
	}),
}));

function makeRemoteSandbox(sandboxId = 'sbx-remote-1') {
	return {
		sandboxId,
		commands: {
			run: vi.fn(),
		},
		files: {
			read: vi.fn(),
			write: vi.fn(),
			writeFiles: vi.fn(),
			list: vi.fn(),
			makeDir: vi.fn(),
			rename: vi.fn(),
			remove: vi.fn(),
			exists: vi.fn(),
			getInfo: vi.fn(),
		},
	};
}

describe('E2bSandbox', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockList.mockReturnValue({
			nextItems: vi.fn().mockResolvedValue([]),
		});
		mockKill.mockResolvedValue(true);
		mockPause.mockResolvedValue(true);
	});

	it('creates a sandbox with metadata identity and template when none exists', async () => {
		const remote = makeRemoteSandbox('sbx-created');
		mockCreate.mockResolvedValue(remote);

		const sandbox = new E2bSandbox({
			id: 'agent-ws-123',
			apiKey: 'e2b_test',
			template: 'custom-tpl',
			domain: 'e2b.internal',
			metadata: { agent: 'a1' },
			ephemeral: true,
			timeout: 60_000,
		});

		await sandbox._start();

		expect(mockList).toHaveBeenCalledWith({
			apiKey: 'e2b_test',
			domain: 'e2b.internal',
			query: {
				metadata: { n8n_sandbox_id: 'agent-ws-123' },
				state: ['running', 'paused'],
			},
			limit: 1,
		});
		expect(mockCreate).toHaveBeenCalledWith('custom-tpl', {
			apiKey: 'e2b_test',
			domain: 'e2b.internal',
			timeoutMs: 60_000,
			envs: undefined,
			metadata: {
				agent: 'a1',
				n8n_sandbox_id: 'agent-ws-123',
			},
			lifecycle: { onTimeout: 'kill' },
		});
		expect(sandbox.status).toBe('running');
		expect(sandbox.getInfo().metadata?.remoteSandboxId).toBe('sbx-created');
	});

	it('reconnects to an existing running or paused sandbox by deterministic identity', async () => {
		const remote = makeRemoteSandbox('sbx-existing');
		mockList.mockReturnValue({
			nextItems: vi.fn().mockResolvedValue([{ sandboxId: 'sbx-existing' }]),
		});
		mockConnect.mockResolvedValue(remote);

		const sandbox = new E2bSandbox({
			id: 'thread-abc',
			apiKey: 'e2b_test',
			timeout: 45_000,
		});

		await sandbox._start();

		expect(mockConnect).toHaveBeenCalledWith('sbx-existing', {
			apiKey: 'e2b_test',
			timeoutMs: 45_000,
		});
		expect(mockCreate).not.toHaveBeenCalled();
	});

	it('executes commands and converts CommandExitError into a non-zero CommandResult', async () => {
		const remote = makeRemoteSandbox();
		mockCreate.mockResolvedValue(remote);
		remote.commands.run
			.mockResolvedValueOnce({ exitCode: 0, stdout: 'hello\n', stderr: '' })
			.mockRejectedValueOnce(new MockCommandExitError({ exitCode: 2, stdout: '', stderr: 'bad' }));

		const sandbox = new E2bSandbox({ apiKey: 'e2b_test' });

		const ok = await sandbox.executeCommand('echo', ['hello']);
		expect(ok).toMatchObject({
			success: true,
			exitCode: 0,
			stdout: 'hello\n',
			stderr: '',
		});

		const failed = await sandbox.executeCommand('false');
		expect(failed).toMatchObject({
			success: false,
			exitCode: 2,
			stdout: '',
			stderr: 'bad',
		});
	});

	it('recovers and retries once when a sandbox stops or expires mid-session', async () => {
		const first = makeRemoteSandbox('sbx-1');
		const second = makeRemoteSandbox('sbx-2');
		mockCreate.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
		first.commands.run.mockRejectedValueOnce(new MockSandboxNotRunningError('paused'));
		mockConnect.mockRejectedValueOnce(new MockSandboxNotFoundError('gone'));
		second.commands.run.mockResolvedValueOnce({ exitCode: 0, stdout: 'recovered', stderr: '' });

		const sandbox = new E2bSandbox({ id: 'thread-recover', apiKey: 'e2b_test' });
		const result = await sandbox.executeCommand('printf', ['recovered']);

		expect(result.success).toBe(true);
		expect(result.stdout).toBe('recovered');
		expect(mockCreate).toHaveBeenCalledTimes(2);
	});

	it('wraps E2B SDK acquisition failures in SandboxAcquisitionError', async () => {
		mockCreate.mockRejectedValueOnce(new MockAuthenticationError('Invalid API key'));

		const sandbox = new E2bSandbox({ apiKey: 'bad-key' });

		await expect(sandbox._start()).rejects.toBeInstanceOf(SandboxAcquisitionError);
	});

	it('pauses on stop and kills on destroy and deleteRemote', async () => {
		const remote = makeRemoteSandbox('sbx-life');
		mockCreate.mockResolvedValue(remote);

		const sandbox = new E2bSandbox({ id: 'life-1', apiKey: 'e2b_test' });
		await sandbox._start();
		await sandbox._stop();
		expect(mockPause).toHaveBeenCalledWith('sbx-life', { apiKey: 'e2b_test' });

		await sandbox._destroy();
		expect(mockKill).toHaveBeenCalledWith('sbx-life', { apiKey: 'e2b_test' });
	});

	it('deleteRemote finds and kills sandboxes by identity when never started locally', async () => {
		mockList.mockReturnValue({
			nextItems: vi.fn().mockResolvedValue([{ sandboxId: 'sbx-remote-orphan' }]),
		});

		const sandbox = new E2bSandbox({ id: 'orphan-1', apiKey: 'e2b_test' });
		await sandbox.deleteRemote();

		expect(mockKill).toHaveBeenCalledWith('sbx-remote-orphan', { apiKey: 'e2b_test' });
	});
});

describe('E2bFilesystem', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockList.mockReturnValue({
			nextItems: vi.fn().mockResolvedValue([]),
		});
	});

	it('delegates file read, write, append, readdir, exists, and stat to E2B files API', async () => {
		const remote = makeRemoteSandbox('sbx-fs');
		mockCreate.mockResolvedValue(remote);
		remote.files.read.mockResolvedValueOnce(new Uint8Array(Buffer.from('hello')));
		remote.files.read.mockRejectedValueOnce(new MockFileNotFoundError('missing'));
		remote.files.list.mockResolvedValueOnce([
			{ name: 'src', path: '/home/user/workspace/src', type: 'dir', size: 0 },
			{ name: 'a.ts', path: '/home/user/workspace/a.ts', type: 'file', size: 12 },
		]);
		remote.files.exists.mockResolvedValueOnce(true);
		remote.files.getInfo.mockResolvedValueOnce({
			name: 'a.ts',
			path: '/home/user/workspace/a.ts',
			type: 'file',
			size: 12,
			modifiedTime: new Date('2026-01-01T00:00:00Z'),
		});

		const sandbox = new E2bSandbox({ apiKey: 'e2b_test' });
		const fs = new E2bFilesystem(sandbox);

		expect(await fs.readFile('/home/user/workspace/a.ts', { encoding: 'utf-8' })).toBe('hello');

		await fs.appendFile('/home/user/workspace/new.txt', 'appended');
		expect(remote.files.write).toHaveBeenCalledWith(
			'/home/user/workspace/new.txt',
			Buffer.from('appended'),
			{ signal: undefined },
		);

		expect(await fs.readdir('/home/user/workspace')).toEqual([
			{ name: 'src', type: 'directory', size: 0 },
			{ name: 'a.ts', type: 'file', size: 12 },
		]);
		expect(await fs.exists('/home/user/workspace/a.ts')).toBe(true);
		expect(await fs.stat('/home/user/workspace/a.ts')).toEqual({
			name: 'a.ts',
			path: '/home/user/workspace/a.ts',
			type: 'file',
			size: 12,
			createdAt: new Date('2026-01-01T00:00:00Z'),
			modifiedAt: new Date('2026-01-01T00:00:00Z'),
		});
	});
});
