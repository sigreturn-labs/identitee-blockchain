import { LocationProvider, Route, Router } from "preact-iso";
import { NotFound } from "./pages/not-found.tsx";
import { Background } from "./ui/background.tsx";
import { Header } from "./ui/header.tsx";
import { lazyPage } from "./ui/lazy-page.tsx";

// Every page is its own chunk, loaded when its route is visited: the chain libraries behind the
// pages (@polkadot/*, most of the weight of the app) stay out of the first download, and the
// first screen shows without them. `lazyPage` shows a quiet card meanwhile, and a Reload card if
// the chunk cannot be fetched (a tab left open across a release).
// The profile pages take a while to arrive (the chain libraries come with them): they stand in
// with the skeleton of a profile card. The others are small and show nothing meanwhile.
const Nothing = () => null;
const Home = lazyPage(() => import("./pages/home.tsx").then((m) => m.Home), Nothing);
const Me = lazyPage(() => import("./pages/me.tsx").then((m) => m.Me), Nothing);
const Requests = lazyPage(() => import("./pages/requests.tsx").then((m) => m.Requests), Nothing);
const Authority = lazyPage(() => import("./pages/authority.tsx").then((m) => m.Authority), Nothing);
const AddressProfile = lazyPage(() => import("./pages/address-profile.tsx").then((m) => m.AddressProfile));
const NameProfile = lazyPage(() => import("./pages/name-profile.tsx").then((m) => m.NameProfile));

// preact-iso takes the first route that matches: the fixed paths come before `/:name`, or a
// username would shadow them (the same paths are in RESERVED_PATHS, routes.ts).
export function App() {
  return (
    <LocationProvider>
      <Background />
      <div class="scene">
        <Header />
        <main class="stage">
          <Router>
            <Route path="/" component={Home} />
            <Route path="/me" component={Me} />
            <Route path="/requests" component={Requests} />
            <Route path="/authority" component={Authority} />
            <Route path="/a/:address" component={AddressProfile} />
            <Route path="/:name" component={NameProfile} />
            <Route default component={NotFound} />
          </Router>
        </main>
      </div>
    </LocationProvider>
  );
}
