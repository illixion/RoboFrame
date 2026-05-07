/**
 * Auth Overlay for WebOverlay
 *
 * Usage:
 *   AuthOverlay.show()  - Display the auth overlay
 *   AuthOverlay.hide()  - Hide the auth overlay (if needed)
 *
 * Requires WebOverlay's __overlayControl API for password verification.
 */
var AuthOverlay = (function() {
    var overlay = null;
    var input = null;
    var error = null;
    var wrap = null;

    function create() {
        if (overlay) return;

        var container = document.getElementById('auth-overlay');
        if (!container) {
            container = document.createElement('div');
            container.id = 'auth-overlay';
            document.body.appendChild(container);
        }

        container.innerHTML =
            '<div class="auth-overlay" id="auth-overlay-bg">' +
                '<div class="auth-box">' +
                    '<div class="auth-icon">🔒</div>' +
                    '<div class="auth-title">Enter Password</div>' +
                    '<div class="auth-input-wrap" id="auth-wrap">' +
                        '<input type="password" class="auth-input" id="auth-input" placeholder="Password" autocomplete="off">' +
                        '<button class="auth-submit" id="auth-submit">→</button>' +
                    '</div>' +
                    '<div class="auth-error" id="auth-error"></div>' +
                '</div>' +
            '</div>';

        overlay = document.getElementById('auth-overlay-bg');
        input = document.getElementById('auth-input');
        error = document.getElementById('auth-error');
        wrap = document.getElementById('auth-wrap');

        document.getElementById('auth-submit').onclick = submit;
        input.onkeydown = function(e) {
            e.stopPropagation();
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') AuthOverlay.hide();
        };
    }

    function submit() {
        var pwd = input.value;
        if (!pwd) return;

        input.disabled = true;
        error.textContent = '';

        if (window.__overlayControl && window.__overlayControl.verifyPassword) {
            window.__overlayControl.verifyPassword(pwd);
        } else {
            // Fallback for testing outside WebOverlay
            setTimeout(function() { window.onPasswordIncorrect(); }, 300);
        }
    }

    // Called by WebOverlay when password is wrong
    window.onPasswordIncorrect = function() {
        input.value = '';
        input.disabled = false;
        error.textContent = 'Incorrect password';
        wrap.classList.add('shake');
        setTimeout(function() {
            wrap.classList.remove('shake');
            input.focus();
        }, 400);
    };

    return {
        show: function() {
            create();
            overlay.classList.add('visible');
            setTimeout(function() { input.focus(); }, 100);
        },
        hide: function() {
            if (overlay) overlay.classList.remove('visible');
        },
        isVisible: function() {
            return overlay && overlay.classList.contains('visible');
        }
    };
})();
