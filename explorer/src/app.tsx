import { LocationProvider, Route, Router, useRoute } from "preact-iso";
import { Account } from "./pages/account.tsx";
import { Block } from "./pages/block.tsx";
import { Blocks } from "./pages/blocks.tsx";
import { Events } from "./pages/events.tsx";
import { Extrinsic } from "./pages/extrinsic.tsx";
import { Extrinsics } from "./pages/extrinsics.tsx";
import { Home } from "./pages/home.tsx";
import { Layout } from "./ui/layout.tsx";

// Placeholder pages until each page is written: the title of the page and the id it was given.
function Placeholder({ title, param }: { title: string; param?: string }) {
  const { params } = useRoute();
  const id = param ? params[param] : undefined;
  return (
    <section class="x-page">
      <h1>{id ? `${title} ${id}` : title}</h1>
    </section>
  );
}

const page = (title: string, param?: string) => () => <Placeholder title={title} param={param} />;

const ROUTES: Array<[path: string, component: () => preact.JSX.Element]> = [
  ["/", Home],
  ["/blocks", Blocks],
  ["/block/:id", Block],
  ["/extrinsics", Extrinsics],
  ["/extrinsic/:id", Extrinsic],
  ["/events", Events],
  ["/account/:address", Account],
  ["/authorities", page("Authorities")],
  ["/authority/:id", page("Authority", "id")],
  ["/attestations", page("Attestations")],
  ["/migrations", page("Migrations")],
  ["/usernames", page("Usernames")],
  ["/runtime", page("Runtime")],
  ["/network", page("Network")],
  ["/search", page("Search")],
];

export const ROUTE_PATHS = ROUTES.map(([path]) => path);

const NotFound = page("Page not found");

export function App() {
  return (
    <LocationProvider>
      <Layout>
        <Router>
          {[
            ...ROUTES.map(([path, component]) => <Route key={path} path={path} component={component} />),
            <Route key="default" default component={NotFound} />,
          ]}
        </Router>
      </Layout>
    </LocationProvider>
  );
}
