import { ControllerRegistryMetadata } from '@n8n/decorators';
import { Container } from '@n8n/di';

import { PublicCanvasManagementController } from '../public-canvas-management.controller';
import { PublicCanvasController } from '../public-canvas.controller';

describe('PublicCanvas controllers route access scopes', () => {
	const metadataRegistry = Container.get(ControllerRegistryMetadata);

	describe('PublicCanvasManagementController', () => {
		const metadata = metadataRegistry.getControllerMetadata(
			PublicCanvasManagementController as never,
		);
		const routeCases = Array.from(metadata.routes.entries()).map(([handlerName, route]) => ({
			handlerName,
			route,
		}));

		it.each(routeCases)(
			'$handlerName is gated by a project-scoped workflow:* check',
			({ route }) => {
				expect(route.skipAuth).toBeFalsy();
				expect(route.accessScope).toBeDefined();
				expect(route.accessScope?.globalOnly).toBe(false);
				expect(route.accessScope?.scope.startsWith('workflow:')).toBe(true);
			},
		);
	});

	describe('PublicCanvasController', () => {
		const metadata = metadataRegistry.getControllerMetadata(PublicCanvasController as never);
		const routeCases = Array.from(metadata.routes.entries()).map(([handlerName, route]) => ({
			handlerName,
			route,
		}));

		it.each(routeCases)(
			'$handlerName explicitly skips session auth for token-gated read-only access',
			({ route }) => {
				expect(route.accessScope).toBeUndefined();
				expect(route.skipAuth).toBe(true);
				expect(route.allowBots).toBe(true);
			},
		);
	});
});
