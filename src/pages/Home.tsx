import { Link } from 'react-router-dom';
import { Database, Zap, ArrowRight, Server } from 'lucide-react';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';

export default function Home() {
  return (
    <>
      <Navbar />
      <main>
        <section className="hero">
          <div className="hero-glow"></div>
          <div className="container">
            <div className="full-form">Journaled Async Relay</div>
            <h1>Kafka-style durability.<br />MQTT-native interface.</h1>
            <p className="subtitle">
              A high-performance message broker that speaks standard MQTT.
              One binary. No JVM. No Zookeeper.
              Store every message in a durable, append-only commit log and replay from anywhere.
            </p>
            <div className="hero-actions">
              <Link to="/docs" className="btn btn-primary">
                Read Documentation
                <ArrowRight size={16} style={{ marginLeft: '0.5rem' }} />
              </Link>
              <a href="https://github.com/thisisanshrastogi/jar" target="_blank" rel="noopener noreferrer" className="btn btn-secondary">
                View Source
              </a>
            </div>

            <div className="terminal">
              <div className="terminal-header">
                <div className="terminal-dot" style={{ backgroundColor: '#ef4444' }}></div>
                <div className="terminal-dot" style={{ backgroundColor: '#eab308' }}></div>
                <div className="terminal-dot" style={{ backgroundColor: '#22c55e' }}></div>
              </div>
              <div>
                <span className="code-comment"># Build the broker from source</span><br />
                <span className="code-command">go build</span> -o jar ./cmd/jar<br /><br />
                <span className="code-comment"># Run with defaults (MQTT on :2707, Admin on :8080)</span><br />
                <span className="code-command">./jar</span><br /><br />
                <span className="code-comment"># Publish standard MQTT messages instantly</span><br />
                <span className="code-command">mosquitto_pub</span> -h localhost -p 2707 -t <span className="code-arg">"sensors/temp"</span> -m <span className="code-arg">"22.5"</span>
              </div>
            </div>
          </div>
        </section>

        <section className="features-section">
          <div className="container">
            <h2 className="text-center" style={{ fontSize: '2.5rem', marginBottom: '1rem', letterSpacing: '-0.03em' }}>Why JAR?</h2>
            <p className="text-center subtitle" style={{ maxWidth: '600px', margin: '0 auto', color: 'var(--text-secondary)' }}>
              Built from the ground up to solve the exact gap between traditional MQTT brokers and enterprise event streaming platforms.
            </p>

            <div className="bento-grid">
              {/* Card 1: Large (Spans 2 columns) */}
              <div className="bento-card bento-large">
                <div className="bento-icon">
                  <Database size={24} />
                </div>
                <h3>Append-Only Commit Log</h3>
                <p>Messages survive restarts. Consumers can replay history from any offset without data loss, giving you absolute Kafka-level guarantees in IoT environments.</p>
              </div>

              {/* Card 2: Tall (Spans 2 rows) */}
              <div className="bento-card bento-tall">
                <div className="bento-icon">
                  <Server size={24} />
                </div>
                <h3>Native MQTT Pub/Sub</h3>
                <p>No SDKs required. Standard clients like mosquitto_pub, Paho, and existing IoT hardware connect via standard push-based Pub/Sub right out of the box with persistent sessions.</p>
              </div>

              {/* Card 3: Standard (1 column) */}
              <div className="bento-card">
                <div className="bento-icon">
                  <Zap size={24} />
                </div>
                <h3>High Throughput</h3>
                <p>Batched fsync ensures incredible write speeds without sacrificing disk durability.</p>
              </div>

              {/* Card 4: Standard (1 column) */}
              <div className="bento-card">
                <div className="bento-icon">
                  <Database size={24} />
                </div>
                <h3>Pull-Based Broker</h3>
                <p>While IoT devices push data, your backend services can safely consume at their own pace via a custom offset-based pull protocol.</p>
              </div>
            </div>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
