import { render } from "preact";
import { App } from "./app.tsx";
import "@web/ui/tokens.css";
import "@web/ui/ui.css";
import "./ui/explorer.css";

render(<App />, document.getElementById("app")!);
