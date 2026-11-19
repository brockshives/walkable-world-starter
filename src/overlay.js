// Fullscreen blocking overlay for the one thing that can stop us: no WebGL.

export function showWebGLFailure() {
  const content = document.getElementById('overlay-content');
  content.innerHTML = `
    <h2>WebGL isn't available</h2>
    <p class="lead">This world needs WebGL 2 to render. Your browser or GPU driver said no.</p>
    <ol>
      <li>Try Chrome or Edge, updated to the latest version.</li>
      <li>Check that hardware acceleration is enabled in browser settings.</li>
      <li>Update your GPU drivers.</li>
    </ol>
  `;
  document.getElementById('overlay').classList.remove('hidden');
}
