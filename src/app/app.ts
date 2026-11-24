import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: `
    <main class="shell">
      <header class="header">
        <span class="brand">CANAL DARK</span>
      </header>
      <section class="content">
        <h1>Canal Dark</h1>
        <p>Aplicação Angular configurada e em execução.</p>
      </section>
      <router-outlet />
    </main>
  `,
  styles: [
    `
      .shell {
        min-height: 100vh;
        display: flex;
        flex-direction: column;
        background: #0b0d12;
        color: #e6e9ef;
      }
      .header {
        padding: 1rem 1.5rem;
        border-bottom: 1px solid #1e2330;
        background: #11151e;
      }
      .brand {
        font-weight: 700;
        letter-spacing: 0.08em;
        font-size: 0.95rem;
        color: #f8fafc;
      }
      .content {
        max-width: 720px;
        margin: 3rem auto;
        padding: 0 1.5rem;
      }
      h1 {
        margin: 0 0 0.75rem;
        font-size: 2rem;
      }
      p {
        margin: 0;
        color: #94a3b8;
        line-height: 1.6;
      }
    `,
  ],
})
export class App {}
