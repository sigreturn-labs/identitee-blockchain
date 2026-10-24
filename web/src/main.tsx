import { render } from "preact";
import { App } from "./app.tsx";
import "./ui/tokens.css";
import "./ui/ui.css";

render(<App />, document.getElementById("app")!);
