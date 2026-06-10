export default function Footer() {
  return (
    <footer className="footer">
      <div className="container footer-inner">
        <p>
          &copy; {new Date().getFullYear()} JAR Message Broker. 
          <span style={{ color: 'var(--text-secondary)', marginLeft: '0.5rem' }}>
            Built by <a href="https://github.com/thisisanshrastogi" target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'underline' }}>the dev</a>
          </span>
        </p>
        <div className="nav-links">
          <a href="https://github.com/thisisanshrastogi/jar" target="_blank" rel="noopener noreferrer" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            GitHub
          </a>
        </div>
      </div>
    </footer>
  );
}
