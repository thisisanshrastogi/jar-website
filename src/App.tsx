import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Home from './pages/Home';
import Docs from './pages/Docs';

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/docs" element={<Navigate to="/docs/architecture" replace />} />
        <Route path="/docs/:id" element={<Docs />} />
      </Routes>
    </Router>
  );
}

export default App;
