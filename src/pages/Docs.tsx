import { useState, useEffect } from 'react';
import { NavLink, useParams, Navigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
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

  useEffect(() => {
    if (!id) return;
    
    setLoading(true);
    // Dynamic import with Vite's ?raw to get text content
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
          <div className="docs-sidebar-section">
            <h4 className="docs-sidebar-title">Getting Started</h4>
            <div className="docs-sidebar-links">
              {DOC_PAGES.map((page) => (
                <NavLink 
                  key={page.id} 
                  to={`/docs/${page.id}`}
                  className={({ isActive }) => isActive ? 'active' : ''}
                >
                  {page.title}
                </NavLink>
              ))}
            </div>
          </div>
        </aside>
        
        <main className="docs-content">
          {loading ? (
            <div style={{ color: 'var(--text-secondary)' }}>Loading documentation...</div>
          ) : (
            <div className="markdown-content">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {content}
              </ReactMarkdown>
            </div>
          )}
        </main>
      </div>
      <Footer />
    </>
  );
}
