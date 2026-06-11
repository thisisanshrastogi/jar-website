import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Menu, X } from 'lucide-react';

export default function Navbar() {
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  const toggleMenu = () => setMenuOpen((prev) => !prev);
  const closeMenu = () => setMenuOpen(false);

  return (
    <nav className="navbar">
      <div className="container navbar-inner">
        <Link to="/" className="nav-brand" style={{ letterSpacing: '0.2em' }} onClick={closeMenu}>
          JAR
        </Link>

        {/* Desktop links */}
        <div className="nav-links nav-links-desktop">
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

        {/* Hamburger button */}
        <button
          className="nav-hamburger"
          onClick={toggleMenu}
          aria-label="Toggle menu"
          aria-expanded={menuOpen}
        >
          {menuOpen ? <X size={22} /> : <Menu size={22} />}
        </button>
      </div>

      {/* Mobile drawer */}
      {menuOpen && (
        <div className="nav-mobile-menu">
          <Link to="/" className={location.pathname === '/' ? 'active' : ''} onClick={closeMenu}>
            Home
          </Link>
          <Link
            to="/docs"
            className={location.pathname.startsWith('/docs') ? 'active' : ''}
            onClick={closeMenu}
          >
            Documentation
          </Link>
          <a
            href="https://github.com/thisisanshrastogi/jar"
            target="_blank"
            rel="noopener noreferrer"
            onClick={closeMenu}
          >
            GitHub
          </a>
        </div>
      )}
    </nav>
  );
}
