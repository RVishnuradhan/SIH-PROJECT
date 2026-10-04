// ---------- Data ----------
const DEFAULTS = {
  name: "Your Name",
  bio: "Curious learner who loves turning ideas into interactive web experiences."
};
const ROLES = ["Web Developer", "Problem Solver", "Student", "Tech Enthusiast"];
const SKILLS = [
  { name: "HTML", level: 90 },
  { name: "CSS", level: 80 },
  { name: "JavaScript", level: 75 },
  { name: "Git & GitHub", level: 65 }
];
const PROJECTS = [
  { title: "Portfolio Site", type: "Web", desc: "Responsive personal website." },
  { title: "To-Do App", type: "JavaScript", desc: "Add, complete and delete tasks." },
  { title: "Weather Widget", type: "JavaScript", desc: "Fetches live weather from an API." },
  { title: "Landing Page", type: "Web", desc: "Clean marketing page with CSS grid." },
  { title: "Quiz Game", type: "JavaScript", desc: "Timed multiple-choice quiz." }
];

const $ = (id) => document.getElementById(id);
const store = {
  get(k, fallback) { try { return localStorage.getItem(k) ?? fallback; } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  remove(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
};

// ---------- Profile (name / bio, saved in localStorage) ----------
function renderProfile() {
  const name = store.get("pf_name", DEFAULTS.name);
  const bio = store.get("pf_bio", DEFAULTS.bio);
  $("displayName").textContent = name;
  $("displayBio").textContent = bio;
  $("logoName").textContent = name;
  $("avatar").textContent = (name.trim()[0] || "?").toUpperCase();
  document.title = `${name} | Profile`;
}
$("editToggle").addEventListener("click", () => {
  $("inName").value = store.get("pf_name", DEFAULTS.name);
  $("inBio").value = store.get("pf_bio", DEFAULTS.bio);
  $("editForm").classList.toggle("hidden");
});
$("editForm").addEventListener("submit", (e) => {
  e.preventDefault();
  store.set("pf_name", $("inName").value.trim() || DEFAULTS.name);
  store.set("pf_bio", $("inBio").value.trim() || DEFAULTS.bio);
  renderProfile();
  $("editForm").classList.add("hidden");
});
$("resetProfile").addEventListener("click", () => {
  store.remove("pf_name"); store.remove("pf_bio");
  renderProfile();
  $("editForm").classList.add("hidden");
});

// ---------- Greeting & live clock ----------
function updateClock() {
  const now = new Date();
  const h = now.getHours();
  const part = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  $("greeting").textContent = `${part}! 👋 Welcome to my page`;
  $("clock").textContent = now.toLocaleTimeString();
}
updateClock();
setInterval(updateClock, 1000);

// ---------- Typing effect ----------
(function typeLoop() {
  let r = 0, c = 0, deleting = false;
  function tick() {
    const word = ROLES[r];
    c += deleting ? -1 : 1;
    $("typed").textContent = word.slice(0, c);
    let delay = deleting ? 50 : 100;
    if (!deleting && c === word.length) { deleting = true; delay = 1200; }
    else if (deleting && c === 0) { deleting = false; r = (r + 1) % ROLES.length; delay = 300; }
    setTimeout(tick, delay);
  }
  tick();
})();

// ---------- Dark mode ----------
function applyTheme(dark) {
  document.body.classList.toggle("dark", dark);
  $("themeToggle").textContent = dark ? "☀️" : "🌙";
}
applyTheme(store.get("pf_theme", "light") === "dark");
$("themeToggle").addEventListener("click", () => {
  const dark = !document.body.classList.contains("dark");
  applyTheme(dark);
  store.set("pf_theme", dark ? "dark" : "light");
});

// ---------- Skills (animated bars when scrolled into view) ----------
$("skillList").innerHTML = SKILLS.map((s) => `
  <div class="skill">
    <div class="skill-head"><span>${s.name}</span><span>${s.level}%</span></div>
    <div class="bar"><span data-level="${s.level}"></span></div>
  </div>`).join("");
const skillObserver = new IntersectionObserver((entries) => {
  entries.forEach((en) => {
    if (en.isIntersecting) {
      en.target.querySelectorAll(".bar span").forEach((b) => (b.style.width = b.dataset.level + "%"));
      skillObserver.unobserve(en.target);
    }
  });
}, { threshold: 0.3 });
skillObserver.observe($("skillList"));

// ---------- Projects with category filter ----------
const categories = ["All", ...new Set(PROJECTS.map((p) => p.type))];
function renderProjects(filter) {
  $("filters").innerHTML = categories
    .map((c) => `<button class="${c === filter ? "active" : ""}" data-cat="${c}">${c}</button>`).join("");
  $("projectGrid").innerHTML = PROJECTS
    .filter((p) => filter === "All" || p.type === filter)
    .map((p) => `<article class="card project"><h3>${p.title}</h3>
      <span class="tag">${p.type}</span><p>${p.desc}</p></article>`).join("");
}
$("filters").addEventListener("click", (e) => {
  if (e.target.dataset.cat) renderProjects(e.target.dataset.cat);
});
renderProjects("All");

// ---------- Contact form validation ----------
function setError(input, msg) {
  const label = input.closest("label");
  label.classList.toggle("invalid", !!msg);
  label.querySelector(".err").textContent = msg;
  return !msg;
}
$("contactForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("cName"), email = $("cEmail"), msg = $("cMsg");
  const ok = [
    setError(name, name.value.trim().length < 2 ? "Please enter your name." : ""),
    setError(email, /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value) ? "" : "Enter a valid email."),
    setError(msg, msg.value.trim().length < 10 ? "Message must be at least 10 characters." : "")
  ].every(Boolean);
  const status = $("formStatus");
  if (ok) {
    status.textContent = `Thanks ${name.value.trim()}! Your message was sent (demo).`;
    e.target.reset();
  } else {
    status.textContent = "";
  }
});

// ---------- Visit counter, scroll-to-top, footer year ----------
const visits = (parseInt(store.get("pf_visits", "0"), 10) || 0) + 1;
store.set("pf_visits", String(visits));
$("visits").textContent = visits;
$("year").textContent = new Date().getFullYear();
window.addEventListener("scroll", () => $("toTop").classList.toggle("hidden", window.scrollY < 300));
$("toTop").addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));

renderProfile();
