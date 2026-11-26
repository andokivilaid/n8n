import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule, LOWEST_SHUTDOWN_PRIORITY, OnShutdown } from '@n8n/decorators';
import { Container } from '@n8n/di';
import { InstanceSettings } from 'n8n-core';

@BackendModule({
	name: 'public-canvas',
	instanceTypes: ['main', 'worker', 'webhook'],
})
export class PublicCanvasModule implements ModuleInterface {
	async init() {
		const { PublicCanvasShareService } = await import('./public-canvas-share.service.js');
		await Container.get(PublicCanvasShareService).init();

		const { PublicCanvasStreamService } = await import('./public-canvas-stream.service.js');
		Container.get(PublicCanvasStreamService).init();

		const { PublicCanvasLifecycleHandler } = await import('./public-canvas-lifecycle.handler.js');
		Container.get(PublicCanvasLifecycleHandler);

		if (Container.get(InstanceSettings).instanceType === 'main') {
			await import('./public-canvas-management.controller.js');
			await import('./public-canvas.controller.js');
		}
	}

	@OnShutdown(LOWEST_SHUTDOWN_PRIORITY)
	async shutdown() {
		const { PublicCanvasStreamService } = await import('./public-canvas-stream.service.js');
		Container.get(PublicCanvasStreamService).shutdown();
	}
}
