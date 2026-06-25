// web/src/App.tsx — the SPA shell (M2.3 scaffold).
//
// Persistent top bar with the product name + a server-owned version chip. The
// shell renders the server view-model; it computes NO projection math.
import { TopBar } from "./components/TopBar";
import "./tokens.css";

export function App() {
  return (
    <div>
      <TopBar />
      <main>
        {/* ListView / Wizard / ProjectionDetail land in M2; this is the shell. */}
      </main>
    </div>
  );
}

export default App;
