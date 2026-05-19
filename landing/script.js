// ALB URL을 환경에 맞게 교체하세요
const APP_URL = 'https://app.psj0514.site';

document.querySelectorAll('#start-btn, #hero-start-btn, #cta-btn').forEach(btn => {
  btn.href = APP_URL;
});

// 스크롤 시 카드 등장 애니메이션
const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry, i) => {
    if (entry.isIntersecting) {
      entry.target.style.animation = `fadeDown 0.5s ${i * 0.1}s ease both`;
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.15 });

document.querySelectorAll('.card').forEach(card => observer.observe(card));
