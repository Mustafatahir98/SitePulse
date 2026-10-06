document.getElementById('loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = document.getElementById('loginButton');
  const error = document.getElementById('loginError');
  button.disabled = true;
  button.textContent = 'Signing in...';
  error.textContent = '';
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: document.getElementById('username').value, password: document.getElementById('password').value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to sign in. Please try again.');
    location.replace('/');
  } catch (failure) {
    error.textContent = failure.message || 'Unable to connect. Please try again.';
    document.getElementById('password').value = '';
  } finally {
    button.disabled = false;
    button.textContent = 'Sign in';
  }
});
