const fs = require('fs');
const files = ['index.html', 'resume.html', 'ats.html', 'pricing.html', 'linkedin.html'];

files.forEach(f => {
  if (!fs.existsSync(f)) return;
  let html = fs.readFileSync(f, 'utf8');
  
  // Try inserting auth-container before the closing </nav> div structure
  if (html.includes('<div class="nav-links">') && !html.includes('id="auth-container"')) {
    html = html.replace('</div>\r\n</nav>', '  <div id="auth-container"></div>\r\n  </div>\r\n</nav>');
    html = html.replace('</div>\n</nav>', '  <div id="auth-container"></div>\n  </div>\n</nav>');
  }

  // Add script tag before </body>
  if (!html.includes('src="auth.js"')) {
    html = html.replace('</body>', '<script type="module" src="auth.js"></script>\n</body>');
  }
  
  fs.writeFileSync(f, html);
  console.log('Updated ' + f);
});
