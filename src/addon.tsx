import { createRoot, type Root } from 'react-dom/client';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { Card, CardContent, Icons } from '@wealthfolio/ui';

function AddonExample({ ctx }: { ctx: AddonContext }) {
  return (
    <div className="p-6">
      <Card>
        <CardContent className="p-6">
          <h1 className="text-2xl font-semibold mb-2">wealthfolio-simplefin-addon</h1>
          <p className="text-muted-foreground">
            Welcome to your new Wealthfolio addon! Start building amazing features.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export default function enable(ctx: AddonContext) {
  let root: Root | null = null;

  // Add a sidebar item
  const sidebarItem = ctx.sidebar.addItem({
    id: 'wealthfolio-simplefin-addon',
    label: 'wealthfolio-simplefin-addon',
    icon: 'bank',
    route: '/addon/wealthfolio-simplefin-addon',
    order: 100,
  });

  // Add a route
  ctx.router.add({
    path: '/addon/wealthfolio-simplefin-addon',
    render: ({ root: routeRoot }) => {
      root ??= createRoot(routeRoot);
      root.render(<AddonExample ctx={ctx} />);
    },
  });

  // Cleanup on disable
  ctx.onDisable(() => {
    try {
      sidebarItem.remove();
      root?.unmount();
      root = null;
    } catch (err) {
      ctx.api.logger.error(`Failed to remove sidebar item: ${String(err)}`);
    }
  });
}
