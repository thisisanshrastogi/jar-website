import { useState, useEffect } from 'react';
import { NavLink, useParams, Navigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronDown, ChevronUp } from 'lucide-react';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';

const DOC_PAGES = [
  { id: 'architecture', title: 'Architecture' },
  { id: 'broker', title: 'Broker' },
  { id: 'storage-engine', title: 'Storage Engine' },
  { id: 'mqtt-handler', title: 'MQTT Handler' },
  { id: 'wire-protocol', title: 'Wire Protocol' },
  { id: 'design-decisions', title: 'Design Decisions' },
  { id: 'operations', title: 'Operations' }
];

export default function Docs() {
  const { id } = useParams<{ id: string }>();
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const currentPage = DOC_PAGES.find((p) => p.id === id);

  useEffect(() => {
    if (!id) return;

    setLoading(true);
    import(`../docs/${id}.md?raw`)
      .then((module) => {
        setContent(module.default);
        setLoading(false);
      })
      .catch((err) => {
        console.error('Failed to load markdown', err);
        setContent('# 404\nDocument not found.');
        setLoading(false);
      });
  }, [id]);

  if (!id) {
    return <Navigate to="/docs/architecture" replace />;
  }

  return (
    <>
      <Navbar />
      <div className="docs-layout container">
        <aside className="docs-sidebar">
          {/* Mobile toggle */}
          <button
            className="docs-sidebar-toggle"
            onClick={() => setSidebarOpen((prev) => !prev)}
            aria-expanded={sidebarOpen}
          >
            <span>{currentPage?.title ?? 'Navigation'}</span>
            {sidebarOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>

          <div className={`docs-sidebar-body${sidebarOpen ? ' open' : ''}`}>
            <div className="docs-sidebar-section">
              <h4 className="docs-sidebar-title">Getting Started</h4>
              <div className="docs-sidebar-links">
                {DOC_PAGES.map((page) => (
                  <NavLink
                    key={page.id}
                    to={`/docs/${page.id}`}
                    className={({ isActive }) => (isActive ? 'active' : '')}
                    onClick={() => setSidebarOpen(false)}
                  >
                    {page.title}
                  </NavLink>
                ))}
              </div>
            </div>
          </div>
        </aside>

        <main className="docs-content">
          {loading ? (
            <div style={{ color: 'var(--text-secondary)' }}>Loading documentation...</div>
          ) : (
            <div className="markdown-content">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            </div>
          )}
        </main>
      </div>
      <Footer />
    </>
  );
}
