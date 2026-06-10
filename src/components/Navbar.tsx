import { Link, useLocation } from 'react-router-dom';

export default function Navbar() {
  const location = useLocation();

  return (
    <nav className="navbar">
      <div className="container navbar-inner">
        <Link to="/" className="nav-brand" style={{ letterSpacing: '0.2em' }}>
          JAR
        </Link>
        <div className="nav-links">
          <Link to="/" className={location.pathname === '/' ? 'active' : ''}>
            Home
          </Link>
          <Link to="/docs" className={location.pathname.startsWith('/docs') ? 'active' : ''}>
            Documentation
          </Link>
          <a href="https://github.com/thisisanshrastogi/jar" target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
        </div>
      </div>
    </nav>
  );
}
