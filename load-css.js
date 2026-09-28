(function loadCss() {
  const href = "https://raw.githack.com/Mikes-Transport/mtw-website-external/main/style.css";
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
})();
