import { useState } from "react";
import "./App.css";

function App() {
  const [greeting, setGreeting] = useState("");

  return (
    <main className="container">
      <h1>PhotoMap</h1>
      <p>{greeting}</p>
    </main>
  );
}

export default App;
