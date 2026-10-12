import Logo from './Logo'
import { useDocumentMeta } from '../utils/useDocumentMeta';
import { PRIVACY_META } from '../utils/pageMeta';
import './PolicyPage.css';

function PolicyPage({ logoSrc, onBack }) {
  useDocumentMeta(PRIVACY_META);

  return (
    <div className="privacy-page">
      <header className="privacy-header">
        {logoSrc && (
          <button type="button" className="privacy-logo-btn" onClick={onBack} title="Back to Tagstash">
            <Logo src={logoSrc} className="privacy-logo" />
          </button>
        )}
        <h1>Privacy Policy</h1>
        <button type="button" className="privacy-header-back" onClick={onBack}>
          &larr; Back to Tagstash
        </button>
      </header>

      <main id="main" tabIndex={-1} className="privacy-content">
        <p className="privacy-effective">Effective date: September 23, 2026</p>

        <section>
          <h2>Overview</h2>
          <p>
            Tagstash ("we", "us", or "our") is operated by Stone Dragon Media LLC and provides
            a tag-based bookmarking service. This policy explains what information we collect,
            how we use it, and your choices.
          </p>
        </section>

        <section>
          <h2>Information We Collect</h2>
          <ul>
            <li>
              <strong>Account information:</strong> username and email address provided when you
              register, plus preferences you set while using the app (such as your selected
              theme).
            </li>
            <li>
              <strong>Bookmarks and tags:</strong> the URLs, titles, descriptions, and tags you
              save to your account.
            </li>
            <li>
              <strong>Billing information:</strong> if you subscribe to Pro, our payment
              processor Stripe handles your payment details directly. We store a Stripe
              customer ID and subscription ID to manage your plan, but we never see or store
              your card number.
            </li>
            <li>
              <strong>Support requests:</strong> the email address and message you submit
              through the in-app Support form.
            </li>
            <li>
              <strong>Usage data:</strong> standard server logs including IP addresses, browser
              type, and pages accessed, used solely for operating and improving the service.
            </li>
          </ul>
        </section>

        <section>
          <h2>How We Use Your Information</h2>
          <ul>
            <li>To provide and maintain your bookmarking account.</li>
            <li>To authenticate you and keep your data secure.</li>
            <li>To process payments and manage subscriptions.</li>
            <li>To respond to support requests.</li>
            <li>To improve the reliability and performance of the service.</li>
          </ul>
          <p>We do not sell or share your personal data with third parties for advertising purposes.</p>
        </section>

        <section>
          <h2>Third-Party Services</h2>
          <p>We rely on a small number of third-party services to operate Tagstash:</p>
          <ul>
            <li>
              <strong>Stripe</strong> processes payments and manages subscriptions for Pro
              accounts. Your email and username are shared with Stripe to associate your
              subscription with your account.
            </li>
            <li>
              <strong>Cloudflare Email Sending</strong> delivers transactional emails
              (verification, password reset), which requires sharing your email address and
              the relevant one-time token with them.
            </li>
            <li>
              <strong>Cloudflare Turnstile</strong> verifies that Support form submissions
              come from a real person rather than a bot.
            </li>
            <li>
              <strong>Google Analytics</strong> helps us understand how visitors use Tagstash
              (such as pages viewed and general usage trends) so we can improve the service.
              Google Analytics sets cookies and collects data like your IP address, browser
              type, and pages visited &mdash; but only if you accept the cookie banner shown
              on your first visit. Nothing is loaded or sent to Google until you accept, and
              the app works identically either way. You can change your choice at any time
              using the "Cookie Choices" link in the footer. See Google's{' '}
              <a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">
                Privacy Policy
              </a>{' '}
              for details on how Google handles this data.
            </li>
            <li>
              When you save or edit a bookmark, our server fetches the destination URL to
              suggest a title and description, and requests a favicon icon for that domain
              from Google's favicon service. These requests go out to the site you're
              bookmarking (and to Google for the icon), not to us. When bookmarks are
              displayed, your browser loads each icon directly from Google, which means
              Google receives your IP address and the domain of the icon requested.
            </li>
          </ul>
        </section>

        <section>
          <h2>Public Profiles (Optional)</h2>
          <p>
            You can choose to make your profile public in Settings. When enabled, your
            username and any bookmarks you haven't marked private become viewable by anyone
            with the link at <code>tagsta.sh/u/your-username</code>, and through a public
            JSON API meant for embedding your bookmarks elsewhere. This is off by default,
            fully opt-in, and can be turned off at any time; you can also mark individual
            bookmarks private to exclude them even while your profile is public.
          </p>
        </section>

        <section>
          <h2>Data Storage</h2>
          <p>
            Your data is stored securely in Cloudflare's infrastructure. Bookmark data is
            associated with your account and is not accessible to other users.
          </p>
        </section>

        <section>
          <h2>Data Retention &amp; Deletion</h2>
          <p>
            Your data is retained as long as your account is active. You may delete individual
            bookmarks at any time. To request full account deletion and removal of all associated
            data, use the in-app Support form (see Contact below).
          </p>
        </section>

        <section>
          <h2>Cookies &amp; Local Storage</h2>
          <p>
            We do not set any cookies ourselves. On your first visit, a banner asks whether
            you'd like to allow Google Analytics; if you accept, it sets its own cookies to
            distinguish visitors and measure usage (see the Third-Party Services section
            above). If you decline or don't respond, no analytics cookies are set. Your
            choice is remembered in local storage, not a cookie, and you can revisit it
            anytime using the "Cookie Choices" link in the footer. The web app also uses
            browser local storage to remember your theme and link-opening preferences and to
            keep you logged in between sessions. If you're logged in, those preferences are
            also saved to your account so they follow you to other browsers and devices. If you use the
            Tagstash browser extension, it similarly stores your session and basic profile
            info locally in your browser (not on any other site) so you stay logged in
            there.
          </p>
        </section>

        <section>
          <h2>Security</h2>
          <p>
            Passwords are hashed before storage. All data is transmitted over HTTPS, and the
            site sends security headers (including a Content Security Policy) that restrict
            which third-party services your browser may contact while using it. We take
            reasonable measures to protect your information but cannot guarantee absolute
            security.
          </p>
        </section>

        <section>
          <h2>Changes to This Policy</h2>
          <p>
            We may update this policy from time to time. Changes will be posted on this page
            with an updated effective date.
          </p>
        </section>

        <section>
          <h2>Contact</h2>
          <p>
            Questions about this policy? Use the in-app Support form and include
            "Privacy Policy" in your message.
          </p>
        </section>
      </main>

      <footer className="privacy-footer">
        <button className="btn-secondary" onClick={onBack}>
          &larr; Back
        </button>
        <span className="privacy-copyright">
          &copy; {new Date().getFullYear()}{' '}
          <a href="https://stonedragonmedia.com/" target="_blank" rel="noopener noreferrer">
            Stone Dragon Media LLC
          </a>
        </span>
      </footer>
    </div>
  );
}

export default PolicyPage;
