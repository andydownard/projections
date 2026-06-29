import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Epic #319 — the account avatar + dropdown that replaces Clerk's <UserButton/>.
// Identity comes from useUser(); actions (openUserProfile / signOut) from
// useClerk(). The trigger is a round avatar (image when the user has one, else
// initials on a brand-tinted circle); the dropdown is a role=menu with "Manage"
// and a destructive "Logout". a11y: aria-expanded on the trigger, first item
// focused on open, Escape + outside-click close and restore focus to the trigger.

const openUserProfile = vi.fn();
const signOut = vi.fn(async () => {});

type MockUser = {
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  hasImage: boolean;
  imageUrl: string;
};

let mockUser: MockUser | null;

vi.mock("@clerk/clerk-react", () => ({
  useUser: () => ({ user: mockUser }),
  useClerk: () => ({ openUserProfile, signOut }),
}));

import { UserMenu } from "./UserMenu";

let assignMock: ReturnType<typeof vi.fn>;
let originalLocation: Location;

beforeEach(() => {
  mockUser = {
    firstName: "Ada",
    lastName: "Lovelace",
    fullName: "Ada Lovelace",
    hasImage: false,
    imageUrl: "https://img.example/ada.png",
  };
  originalLocation = window.location;
  assignMock = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, assign: assignMock },
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: originalLocation,
  });
  vi.clearAllMocks();
});

describe("UserMenu — account avatar + dropdown", () => {
  it("renders the initials avatar when the user has no image", () => {
    render(<UserMenu />);
    const trigger = screen.getByRole("button", { name: /account menu/i });
    expect(trigger).toHaveTextContent("AL");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    // No <img> on the initials path.
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("renders the photo avatar when the user has an image", () => {
    mockUser!.hasImage = true;
    render(<UserMenu />);
    // The avatar image is decorative (empty alt — the trigger's aria-label carries
    // the name), so it has a presentation role; assert the element + src directly.
    const trigger = screen.getByRole("button", { name: /account menu/i });
    const img = trigger.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", "https://img.example/ada.png");
    expect(img).toHaveAttribute("alt", "");
  });

  it("falls back to the full-name initial when first/last are absent", () => {
    mockUser = {
      firstName: null,
      lastName: null,
      fullName: "Grace Hopper",
      hasImage: false,
      imageUrl: "",
    };
    render(<UserMenu />);
    expect(screen.getByRole("button", { name: /account menu/i })).toHaveTextContent("G");
  });

  it("renders nothing while the user is not yet loaded", () => {
    mockUser = null;
    const { container } = render(<UserMenu />);
    expect(container).toBeEmptyDOMElement();
  });

  it("is closed by default — no menu in the DOM until opened", () => {
    render(<UserMenu />);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("opens the menu, flips aria-expanded, and focuses the first item", async () => {
    const user = userEvent.setup();
    render(<UserMenu />);
    const trigger = screen.getByRole("button", { name: /account menu/i });
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("menu");
    expect(menu).toBeInTheDocument();
    const manage = screen.getByRole("menuitem", { name: /manage/i });
    await waitFor(() => expect(manage).toHaveFocus());
  });

  it("'Manage' opens the Clerk user profile and closes the menu", async () => {
    const user = userEvent.setup();
    render(<UserMenu />);
    await user.click(screen.getByRole("button", { name: /account menu/i }));
    await user.click(screen.getByRole("menuitem", { name: /manage/i }));
    expect(openUserProfile).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });

  it("'Logout' signs out and navigates home to '/'", async () => {
    const user = userEvent.setup();
    render(<UserMenu />);
    await user.click(screen.getByRole("button", { name: /account menu/i }));
    await user.click(screen.getByRole("menuitem", { name: /logout/i }));
    expect(signOut).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(assignMock).toHaveBeenCalledWith("/"));
  });

  it("closes on Escape and restores focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<UserMenu />);
    const trigger = screen.getByRole("button", { name: /account menu/i });
    await user.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("closes when clicking outside the menu", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <UserMenu />
        <button type="button">outside</button>
      </div>,
    );
    await user.click(screen.getByRole("button", { name: /account menu/i }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /outside/i }));
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });
});
