// Mobile menu toggle
const menuToggle = document.querySelector('.mobile-menu-toggle');
const navLinks = document.querySelector('.nav-links');

if (menuToggle) {
    menuToggle.addEventListener('click', () => {
        navLinks.classList.toggle('active');
    });
}

// Close mobile menu when a link is clicked
navLinks.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => {
        navLinks.classList.remove('active');
    });
});

// Send a GA4 event when tagged promo links are clicked (data-track="placement_name")
document.querySelectorAll('[data-track]').forEach(el => {
    el.addEventListener('click', () => {
        if (typeof gtag === 'function') {
            gtag('event', 'promo_click', {
                promo_placement: el.dataset.track,
                link_url: el.href,
                transport_type: 'beacon'
            });
        }
    });
});

// Rotating announcement bar
const announcements = document.querySelectorAll('.announcement-bar.rotating a');
if (announcements.length > 1) {
    let current = 0;
    setInterval(() => {
        announcements[current].classList.remove('announcement-active');
        current = (current + 1) % announcements.length;
        announcements[current].classList.add('announcement-active');
    }, 6000);
}
