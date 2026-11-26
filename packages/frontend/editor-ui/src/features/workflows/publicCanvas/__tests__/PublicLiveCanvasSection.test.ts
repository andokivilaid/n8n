import { createTestingPinia } from '@pinia/testing';
import userEvent from '@testing-library/user-event';
import { waitFor } from '@testing-library/vue';

import { createComponentRenderer } from '@/__tests__/render';
import PublicLiveCanvasSection from '@/features/workflows/publicCanvas/components/PublicLiveCanvasSection.vue';
import * as publicCanvasApi from '@/features/workflows/publicCanvas/publicCanvas.api';

const { copyMock, showMessageMock, showErrorMock } = vi.hoisted(() => ({
	copyMock: vi.fn().mockResolvedValue(undefined),
	showMessageMock: vi.fn(),
	showErrorMock: vi.fn(),
}));

vi.mock('@n8n/composables/useClipboard', () => ({
	useClipboard: () => ({
		copy: copyMock,
	}),
}));

vi.mock('@n8n/composables/useToast', () => ({
	useToast: () => ({
		showMessage: showMessageMock,
		showError: showErrorMock,
	}),
}));

vi.mock('@/features/workflows/publicCanvas/publicCanvas.api', () => ({
	getPublicCanvasShareStatus: vi.fn(),
	updatePublicCanvasShareStatus: vi.fn(),
}));

const renderComponent = createComponentRenderer(PublicLiveCanvasSection, {
	pinia: createTestingPinia(),
});

describe('PublicLiveCanvasSection', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('loads and displays the public share link when enabled, and rotates the token on click', async () => {
		vi.mocked(publicCanvasApi.getPublicCanvasShareStatus).mockResolvedValue({
			enabled: true,
			shareToken: 'tok-initial-123',
		});
		vi.mocked(publicCanvasApi.updatePublicCanvasShareStatus).mockResolvedValue({
			enabled: true,
			shareToken: 'tok-rotated-456',
		});

		const { getByTestId } = renderComponent({
			props: {
				projectId: 'proj-1',
				workflowId: 'wf-1',
				isWorkflowSaved: true,
				canUpdate: true,
				ensureWorkflowSaved: vi.fn(),
			},
		});

		await waitFor(() => {
			expect(getByTestId('public-live-canvas-url-row')).toBeInTheDocument();
		});

		const input = getByTestId('public-live-canvas-url-input') as HTMLInputElement;
		expect(input.value).toContain('/public/workflow/tok-initial-123');

		await userEvent.click(getByTestId('public-live-canvas-copy-button'));
		expect(copyMock).toHaveBeenCalledWith(
			expect.stringContaining('/public/workflow/tok-initial-123'),
		);

		await userEvent.click(getByTestId('public-live-canvas-rotate-button'));
		await waitFor(() => {
			expect(publicCanvasApi.updatePublicCanvasShareStatus).toHaveBeenCalledWith(
				expect.anything(),
				'proj-1',
				'wf-1',
				{ enabled: true, rotateToken: true },
			);
			expect((getByTestId('public-live-canvas-url-input') as HTMLInputElement).value).toContain(
				'/public/workflow/tok-rotated-456',
			);
		});
	});

	it('saves an unsaved workflow first before enabling the public live canvas', async () => {
		const ensureWorkflowSaved = vi.fn().mockResolvedValue({
			workflowId: 'wf-saved-99',
			projectId: 'proj-99',
		});
		vi.mocked(publicCanvasApi.updatePublicCanvasShareStatus).mockResolvedValue({
			enabled: true,
			shareToken: 'tok-new-99',
		});

		const { getByTestId } = renderComponent({
			props: {
				projectId: 'proj-99',
				workflowId: 'new-temp-id',
				isWorkflowSaved: false,
				canUpdate: true,
				ensureWorkflowSaved,
			},
		});

		await userEvent.click(getByTestId('public-live-canvas-toggle'));

		await waitFor(() => {
			expect(ensureWorkflowSaved).toHaveBeenCalledOnce();
			expect(publicCanvasApi.updatePublicCanvasShareStatus).toHaveBeenCalledWith(
				expect.anything(),
				'proj-99',
				'wf-saved-99',
				{ enabled: true },
			);
		});
	});
});
